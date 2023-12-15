import { inverseRealFourierTransform, scaleElementsByFactor } from "./FFT";
import { SpectrumWave } from "./SpectrumWave";
import { Config, drawNoiseSpectrum } from "./SynthConfig";
import { Synth } from "./synth";


export class SpectrumWave
{
	public spectrum: number[] = [];
	public hash: number = -1;

	constructor(isNoiseChannel: boolean)
	{
		this.reset(isNoiseChannel);
	}

	public reset(isNoiseChannel: boolean): void
	{
		for (let i: number = 0; i < Config.spectrumControlPoints; i++)
		{
			if (isNoiseChannel)
			{
				this.spectrum[i] = Math.round(Config.spectrumMax * (1 / Math.sqrt(1 + i / 3)));
			} else
			{
				const isHarmonic: boolean = i == 0 || i == 7 || i == 11 || i == 14 || i == 16 || i == 18 || i == 21 || i == 23 || i >= 25;
				this.spectrum[i] = isHarmonic ? Math.max(0, Math.round(Config.spectrumMax * (1 - i / 30))) : 0;
			}
		}
		this.markCustomWaveDirty();
	}

	public markCustomWaveDirty(): void
	{
		const hashMult: number = Synth.fittingPowerOfTwo(Config.spectrumMax + 2) - 1;
		let hash: number = 0;
		for (const point of this.spectrum) hash = ((hash * hashMult) + point) >>> 0;
		this.hash = hash;
	}
}
export class SpectrumWaveState
{
	public wave: Float32Array | null = null;
	private _hash: number = -1;

	public getCustomWave(settings: SpectrumWave, lowestOctave: number): Float32Array
	{
		if (this._hash == settings.hash) return this.wave!;
		this._hash = settings.hash;

		const waveLength: number = Config.spectrumNoiseLength;
		if (this.wave == null || this.wave.length != waveLength + 1)
		{
			this.wave = new Float32Array(waveLength + 1);
		}
		const wave: Float32Array = this.wave;

		for (let i: number = 0; i < waveLength; i++)
		{
			wave[i] = 0;
		}

		const highestOctave: number = 14;
		const falloffRatio: number = 0.25;
		// Nudge the 2/7 and 4/7 control points so that they form harmonic intervals.
		const pitchTweak: number[] = [0, 1 / 7, Math.log2(5 / 4), 3 / 7, Math.log2(3 / 2), 5 / 7, 6 / 7];
		function controlPointToOctave(point: number): number
		{
			return lowestOctave + Math.floor(point / Config.spectrumControlPointsPerOctave) + pitchTweak[(point + Config.spectrumControlPointsPerOctave) % Config.spectrumControlPointsPerOctave];
		}

		let combinedAmplitude: number = 1;
		for (let i: number = 0; i < Config.spectrumControlPoints + 1; i++)
		{
			const value1: number = (i <= 0) ? 0 : settings.spectrum[i - 1];
			const value2: number = (i >= Config.spectrumControlPoints) ? settings.spectrum[Config.spectrumControlPoints - 1] : settings.spectrum[i];
			const octave1: number = controlPointToOctave(i - 1);
			let octave2: number = controlPointToOctave(i);
			if (i >= Config.spectrumControlPoints) octave2 = highestOctave + (octave2 - highestOctave) * falloffRatio;
			if (value1 == 0 && value2 == 0) continue;

			combinedAmplitude += 0.02 * drawNoiseSpectrum(wave, waveLength, octave1, octave2, value1 / Config.spectrumMax, value2 / Config.spectrumMax, -0.5);
		}
		if (settings.spectrum[Config.spectrumControlPoints - 1] > 0)
		{
			combinedAmplitude += 0.02 * drawNoiseSpectrum(wave, waveLength, highestOctave + (controlPointToOctave(Config.spectrumControlPoints) - highestOctave) * falloffRatio, highestOctave, settings.spectrum[Config.spectrumControlPoints - 1] / Config.spectrumMax, 0, -0.5);
		}

		inverseRealFourierTransform(wave, waveLength);
		scaleElementsByFactor(wave, 5 / (Math.sqrt(waveLength) * Math.pow(combinedAmplitude, 0.75)));

		// Duplicate the first sample at the end for easier wrap-around interpolation.
		wave[waveLength] = wave[0];

		return wave;
	}
}

