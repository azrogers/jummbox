/** @format */

import { inverseRealFourierTransform } from "./FFT";
import { Config, InstrumentType, getDrumWave, performIntegralOld } from "./SynthConfig";
import { Synth } from "./synth";

export class HarmonicsWave {
	public harmonics: number[] = [];
	public hash: number = -1;

	constructor() {
		this.reset();
	}

	public reset(): void {
		for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
			this.harmonics[i] = 0;
		}
		this.harmonics[0] = Config.harmonicsMax;
		this.harmonics[3] = Config.harmonicsMax;
		this.harmonics[6] = Config.harmonicsMax;
		this.markCustomWaveDirty();
	}

	public markCustomWaveDirty(): void {
		const hashMult: number = Synth.fittingPowerOfTwo(Config.harmonicsMax + 2) - 1;
		let hash: number = 0;
		for (const point of this.harmonics) hash = (hash * hashMult + point) >>> 0;
		this.hash = hash;
	}
}
export class HarmonicsWaveState {
	public wave: Float32Array | null = null;
	private _hash: number = -1;
	private _generatedForType: InstrumentType = InstrumentType.chip;

	public getCustomWave(settings: HarmonicsWave, instrumentType: InstrumentType): Float32Array {
		if (this._hash == settings.hash && this._generatedForType == instrumentType) return this.wave!;
		this._hash = settings.hash;
		this._generatedForType = instrumentType;

		const harmonicsRendered: number =
			instrumentType == InstrumentType.pickedString
				? Config.harmonicsRenderedForPickedString
				: Config.harmonicsRendered;

		const waveLength: number = Config.harmonicsWavelength;
		const retroWave: Float32Array = getDrumWave(0, null, null);

		if (this.wave == null || this.wave.length != waveLength + 1) {
			this.wave = new Float32Array(waveLength + 1);
		}
		const wave: Float32Array = this.wave;

		for (let i: number = 0; i < waveLength; i++) {
			wave[i] = 0;
		}

		const overallSlope: number = -0.25;
		let combinedControlPointAmplitude: number = 1;

		for (let harmonicIndex: number = 0; harmonicIndex < harmonicsRendered; harmonicIndex++) {
			const harmonicFreq: number = harmonicIndex + 1;
			let controlValue: number =
				harmonicIndex < Config.harmonicsControlPoints
					? settings.harmonics[harmonicIndex]
					: settings.harmonics[Config.harmonicsControlPoints - 1];
			if (harmonicIndex >= Config.harmonicsControlPoints) {
				controlValue *=
					1 -
					(harmonicIndex - Config.harmonicsControlPoints) /
						(harmonicsRendered - Config.harmonicsControlPoints);
			}
			const normalizedValue: number = controlValue / Config.harmonicsMax;
			let amplitude: number = Math.pow(2, controlValue - Config.harmonicsMax + 1) * Math.sqrt(normalizedValue);
			if (harmonicIndex < Config.harmonicsControlPoints) {
				combinedControlPointAmplitude += amplitude;
			}
			amplitude *= Math.pow(harmonicFreq, overallSlope);

			// Multiply all the sine wave amplitudes by 1 or -1 based on the LFSR
			// retro wave (effectively random) to avoid egregiously tall spikes.
			amplitude *= retroWave[harmonicIndex + 589];

			wave[waveLength - harmonicFreq] = amplitude;
		}

		inverseRealFourierTransform(wave, waveLength);

		// Limit the maximum wave amplitude.
		const mult: number = 1 / Math.pow(combinedControlPointAmplitude, 0.7);
		for (let i: number = 0; i < wave.length; i++) wave[i] *= mult;

		performIntegralOld(wave);

		// The first sample should be zero, and we'll duplicate it at the end for easier interpolation.
		wave[waveLength] = wave[0];

		return wave;
	}
}
