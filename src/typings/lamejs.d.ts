/**
 * Declaration file generated by dts-gen
 *
 * @format
 */
declare module "lamejs";

export function Mp3Encoder(channels: any, samplerate: any, kbps: any, ...args: any[]): any;

export function WavHeader(): void;

export namespace WavHeader {
	const RIFF: number;

	const WAVE: number;

	const data: number;

	const fmt_: number;

	function readHeader(dataView: any): any;
}
