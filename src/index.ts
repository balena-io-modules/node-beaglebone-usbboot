import * as usb from 'usb';
import * as _debug from 'debug';
import { EventEmitter } from 'events';
import * as _os from 'os';
import { setInterval, clearInterval } from 'timers';

import { Message } from './messages';

const platform = _os.platform();
const debug = _debug('node-beaglebone-usbboot');

const POLLING_INTERVAL_MS = 2000;
// Delay in ms after which we consider that the device was unplugged (not resetted)
const DEVICE_UNPLUG_TIMEOUT = 5000;

const USB_VENDOR_ID_TEXAS_INSTRUMENTS = 0x0451;
const USB_PRODUCT_ID_ROM = 0x6141;
const USB_PRODUCT_ID_SPL = 0xd022;
const MAX_CLOSE_DEVICE_TRIES = 2;

const getDeviceId = (device: usb.Device): string => {
	return `${device.busNumber}:${device.deviceAddress}`;
};

export const isUsbBootCapableUSBDevice = (
	idVendor: number,
	idProduct: number,
): boolean => {
	return (
		idVendor === USB_VENDOR_ID_TEXAS_INSTRUMENTS &&
		(idProduct === USB_PRODUCT_ID_ROM || idProduct === USB_PRODUCT_ID_SPL)
	);
};

export const isROMUSBDevice = (
	idVendor: number,
	idProduct: number,
): boolean => {
	return (
		idVendor === USB_VENDOR_ID_TEXAS_INSTRUMENTS &&
		idProduct === USB_PRODUCT_ID_ROM
	);
};
export const isSPLUSBDevice = (
	idVendor: number,
	idProduct: number,
): boolean => {
	return (
		idVendor === USB_VENDOR_ID_TEXAS_INSTRUMENTS &&
		idProduct === USB_PRODUCT_ID_SPL
	);
};

const isUsbBootCapableUSBDevice$ = (device: usb.Device): boolean => {
	return isUsbBootCapableUSBDevice(
		device.deviceDescriptor.idVendor,
		device.deviceDescriptor.idProduct,
	);
};

const isBeagleBoneInMassStorageMode = (device: usb.Device): boolean => {
	return (
		device.deviceDescriptor.idVendor === USB_VENDOR_ID_TEXAS_INSTRUMENTS &&
		device.deviceDescriptor.idProduct === USB_PRODUCT_ID_SPL &&
		device.deviceDescriptor.bNumConfigurations === 1
	);
};

const initializeDevice = (
	device: usb.Device,
): {
	inEndpoint: usb.InEndpoint;
	outEndpoint: usb.OutEndpoint;
} => {
	debug('bInterface', device.configDescriptor.bNumInterfaces);
	const interfaceNumber = 1;
	const iface = device.interface(interfaceNumber);
	if (platform !== 'win32') {
		// Not supported in Windows
		// Detach Kernel Driver
		if (iface.isKernelDriverActive()) {
			iface.detachKernelDriver();
		}
	}
	iface.claim();
	const inEndpoint = iface.endpoints[0];
	const outEndpoint = iface.endpoints[1];
	if (!(inEndpoint instanceof usb.InEndpoint)) {
		throw new Error('endpoint is not an usb.OutEndpoint');
	}
	if (!(outEndpoint instanceof usb.OutEndpoint)) {
		throw new Error('endpoint is not an usb.OutEndpoint');
	}
	debug('Initialized device correctly', devicePortId(device));
	return { inEndpoint, outEndpoint };
};

const initializeRNDIS = (device: usb.Device): usb.InEndpoint => {
	const interfaceNumber = 0;
	const iface0 = device.interface(interfaceNumber);
	iface0.claim();
	const iEndpoint = iface0.endpoints[0];
	if (!(iEndpoint instanceof usb.InEndpoint)) {
		throw new Error('endpoint is not an usb.OutEndpoint');
	} else {
		iEndpoint.startPoll(1, 256);
	}

	const CONTROL_BUFFER_SIZE = 1025;
	const message = new Message();
	const initMsg = message.getRNDISInit(); // RNDIS INIT Message
	// Windows Control Transfer
	// https://msdn.microsoft.com/en-us/library/aa447434.aspx
	// http://www.beyondlogic.org/usbnutshell/usb6.shtml
	const bmRequestTypeSend = 0x21; // USB_TYPE=CLASS | USB_RECIPIENT=INTERFACE
	const bmRequestTypeReceive = 0xa1; // USB_DATA=DeviceToHost | USB_TYPE=CLASS | USB_RECIPIENT=INTERFACE

	// Sending rndis_init_msg (SEND_ENCAPSULATED_COMMAND)
	device.controlTransfer(bmRequestTypeSend, 0, 0, 0, initMsg, (error) => {
		if (error) {
			throw new Error(`Control transfer error on SEND_ENCAPSULATED ${error}`);
		}
	});

	// Receive rndis_init_cmplt (GET_ENCAPSULATED_RESPONSE)
	device.controlTransfer(
		bmRequestTypeReceive,
		0x01,
		0,
		0,
		CONTROL_BUFFER_SIZE,
		(error) => {
			if (error) {
				throw new Error(`Control transfer error on GET_ENCAPSULATED ${error}`);
			}
		},
	);

	const setMsg = message.getRNDISSet(); // RNDIS SET Message

	// Send rndis_set_msg (SEND_ENCAPSULATED_COMMAND)
	device.controlTransfer(bmRequestTypeSend, 0, 0, 0, setMsg, (error) => {
		if (error) {
			throw new Error(`Control transfer error on SEND_ENCAPSULATED ${error}`);
		}
	});
	// Receive rndis_init_cmplt (GET_ENCAPSULATED_RESPONSE)
	device.controlTransfer(
		bmRequestTypeReceive,
		0x01,
		0,
		0,
		CONTROL_BUFFER_SIZE,
		(error) => {
			if (error) {
				throw new Error(`Control transfer error on GET_ENCAPSULATED ${error}`);
			}
		},
	);
	return iEndpoint;
};

const stopPoll = async (inEndpoint: usb.InEndpoint) =>
	new Promise<void>((res) => {
		inEndpoint.stopPoll(res);
	});
export class UsbBBbootScanner extends EventEmitter {
	private usbBBbootDevices = new Map<string, UsbBBbootDevice>();
	private boundAttachDevice: (device: usb.Device) => Promise<void>;
	private boundDetachDevice: (device: usb.Device) => void;
	private interval: NodeJS.Timeout | undefined;

	// We use both events ('attach' and 'detach') and polling getDeviceList() on usb.
	// We don't know which one will trigger the this.attachDevice call.
	// So we keep track of attached devices ids in attachedDeviceIds to not run it twice.
	private attachedDeviceIds = new Set<string>();

	constructor() {
		super();
		this.boundAttachDevice = this.attachDevice.bind(this);
		this.boundDetachDevice = this.detachDevice.bind(this);
	}

	public start(): void {
		debug('Waiting for BeagleBone');

		// Prepare already connected devices
		usb.getDeviceList().map(this.boundAttachDevice);

		// At this point all devices from `usg.getDeviceList()` above
		// have had an 'attach' event emitted if they were beaglebone.
		this.emit('ready');
		// Watch for new devices being plugged in and prepare them
		usb.on('attach', this.boundAttachDevice);
		// Watch for devices detaching
		usb.on('detach', this.boundDetachDevice);

		this.interval = setInterval(() => {
			usb.getDeviceList().forEach(this.boundAttachDevice);
		}, POLLING_INTERVAL_MS);
	}

	public stop(): void {
		usb.removeListener('attach', this.boundAttachDevice);
		usb.removeListener('detach', this.boundDetachDevice);
		if (this.interval !== undefined) {
			clearInterval(this.interval);
		}
		this.usbBBbootDevices.clear();
	}

	private step(device: usb.Device, step: number): void {
		const usbBBbootDevice = this.getOrCreate(device);
		usbBBbootDevice.step = step;
		if (step === UsbBBbootDevice.LAST_STEP) {
			this.remove(device);
		}
	}

	private incrementStep(device: usb.Device) {
		const usbBBbootDevice = this.getOrCreate(device);
		this.step(device, usbBBbootDevice.step + 1);
	}

	private get(device: usb.Device): UsbBBbootDevice | undefined {
		const key = devicePortId(device);
		return this.usbBBbootDevices.get(key);
	}

	private getOrCreate(device: usb.Device): UsbBBbootDevice {
		const key = devicePortId(device);
		let usbBBbootDevice = this.usbBBbootDevices.get(key);
		if (usbBBbootDevice === undefined) {
			usbBBbootDevice = new UsbBBbootDevice(key);
			this.usbBBbootDevices.set(key, usbBBbootDevice);
			this.emit('attach', usbBBbootDevice);
		}
		return usbBBbootDevice;
	}

	private remove(device: usb.Device): void {
		const key = devicePortId(device);
		const usbBBbootDevice = this.usbBBbootDevices.get(key);
		if (usbBBbootDevice !== undefined) {
			this.usbBBbootDevices.delete(key);
			this.emit('detach', usbBBbootDevice);
		}
	}

	private async attachDevice(device: usb.Device): Promise<void> {
		if (this.attachedDeviceIds.has(getDeviceId(device))) {
			return;
		}
		this.attachedDeviceIds.add(getDeviceId(device));

		if (
			isBeagleBoneInMassStorageMode(device) &&
			this.usbBBbootDevices.has(devicePortId(device))
		) {
			this.step(device, UsbBBbootDevice.LAST_STEP);
			return;
		}
		if (!isUsbBootCapableUSBDevice$(device)) {
			return;
		}
		if (device.deviceDescriptor.iSerialNumber !== 0) {
			return;
		}
		if (
			isROMUSBDevice(
				device.deviceDescriptor.idVendor,
				device.deviceDescriptor.idProduct,
			)
		) {
			this.process(device, 'u-boot-spl.bin');
		}
		if (
			isSPLUSBDevice(
				device.deviceDescriptor.idVendor,
				device.deviceDescriptor.idProduct,
			)
		) {
			setTimeout(() => {
				this.process(device, 'u-boot.img');
			}, 500);
		}
	}

	private process(device: usb.Device, fileName: string): void {
		try {
			device.open();
			let rndisInEndpoint: usb.InEndpoint;
			if (platform === 'win32' || platform === 'darwin') {
				rndisInEndpoint = initializeRNDIS(device);
				rndisInEndpoint.on('error', (error: Error) => {
					debug('RNDIS InEndpoint Error', error);
				});
			}
			const { inEndpoint, outEndpoint } = initializeDevice(device);
			const serverConfig: any = {};
			serverConfig.bootpFile = fileName;
			inEndpoint.startPoll(1, 500); // MAXBUFF

			inEndpoint.on('error', (error: Error) => {
				debug('InEndpoint Error', error);
			});

			const message = new Message();
			inEndpoint.on('data', async (data: Buffer) => {
				const request = message.identify(data);
				if (request === 'BOOTP') {
					const bootPBuff = message.getBOOTPResponse(data, serverConfig);
					await this.transfer(device, outEndpoint, bootPBuff);
				} else if (request === 'ARP') {
					const arpBuff = message.getARResponse(data, serverConfig);
					await this.transfer(device, outEndpoint, arpBuff);
				} else if (request === 'TFTP') {
					message.getBootFile(data, serverConfig);
					if (!serverConfig.tftp.fileError) {
						const tftpBuff = message.getTFTPData(serverConfig);
						if (tftpBuff !== undefined) {
							await this.transfer(device, outEndpoint, tftpBuff);
						}
					} else {
						await this.transfer(
							device,
							outEndpoint,
							message.getTFTPError(serverConfig),
						);
					}
				} else if (request === 'TFTP_Data') {
					const tftpBuff = message.getTFTPData(serverConfig);
					if (serverConfig.tftp) {
						if (tftpBuff !== undefined) {
							await this.transfer(device, outEndpoint, tftpBuff);
						} else {
							if (platform === 'win32' || platform === 'darwin') {
								await stopPoll(rndisInEndpoint);
							}
							await stopPoll(inEndpoint);
							this.closeDevice(device, 0);
						}
					}
				} else {
					debug('Request', request);
				}
			});
		} catch (error) {
			debug('error', error, devicePortId(device));
			this.remove(device);
		}
	}

	private async transfer(
		device: usb.Device,
		outEndpoint: usb.OutEndpoint,
		response: Buffer,
	) {
		await new Promise<void>((resolve, reject) => {
			outEndpoint.transfer(response, (error?: Error) => {
				if (!error) {
					resolve();
				} else {
					debug('Out transfer Error', error);
					reject(error);
				}
			});
		});
		this.incrementStep(device);
	}

	private closeDevice(device: usb.Device, tries: number): void {
		try {
			debug('Closing device...');
			device.close();
			debug('Device closed.');
		} catch (error: any) {
			const errorMessage: string = error.message;
			if (
				tries < MAX_CLOSE_DEVICE_TRIES &&
				errorMessage === "Can't close device with a pending request"
			) {
				debug('Retrying device.close()...');
				setTimeout(() => {
					this.closeDevice(device, tries + 1);
				}, 150);
			} else {
				console.error(error);
			}
		}
	}

	private detachDevice(device: usb.Device): void {
		this.attachedDeviceIds.delete(getDeviceId(device));
		if (!isUsbBootCapableUSBDevice$(device)) {
			return;
		}
		setTimeout(() => {
			const usbBBbootDevice = this.get(device);
			if (
				usbBBbootDevice !== undefined &&
				usbBBbootDevice.step === UsbBBbootDevice.LAST_STEP
			) {
				debug(
					'device',
					devicePortId(device),
					'did not reattached after',
					DEVICE_UNPLUG_TIMEOUT,
					'ms.',
				);
				this.remove(device);
			}
		}, DEVICE_UNPLUG_TIMEOUT);
	}
}

// tslint:disable-next-line
export class UsbBBbootDevice extends EventEmitter {
	public static readonly LAST_STEP = 1124;
	private _step = 0;
	constructor(public portId: string) {
		super();
	}
	get progress() {
		return Math.floor((this._step / UsbBBbootDevice.LAST_STEP) * 100);
	}
	get step() {
		return this._step;
	}
	set step(step: number) {
		this._step = step;
		this.emit('progress', this.progress);
	}
}

const devicePortId = (device: usb.Device) => {
	let result = `${device.busNumber}`;
	if (device.portNumbers !== undefined) {
		result += `-${device.portNumbers.join('.')}`;
	}
	return result;
};
