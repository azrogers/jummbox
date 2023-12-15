/** @format */

import { Config } from "./SynthConfig";
import { Instrument } from "./Instrument";
import { Synth } from "./synth";
import { InstrumentState } from "./Instrument";
import { Tone } from "./Tone";

export class PickedString {
	public delayLine: Float32Array | null = null;
	public delayIndex: number = 0;
	public allPassSample: number = 0;
	public allPassPrevInput: number = 0;
	public shelfSample: number = 0;
	public shelfPrevInput: number = 0;
	public fractionalDelaySample: number = 0;
	public prevDelayLength: number = 0;
	public delayLengthDelta: number = 0;
	public delayResetOffset: number = 0;

	public allPassG: number = 0;
	public allPassGDelta: number = 0;
	public shelfA1: number = 0;
	public shelfA1Delta: number = 0;
	public shelfB0: number = 0;
	public shelfB0Delta: number = 0;
	public shelfB1: number = 0;
	public shelfB1Delta: number = 0;

	constructor() {
		this.reset();
	}

	public reset(): void {
		this.delayIndex = -1;
		this.allPassSample = 0;
		this.allPassPrevInput = 0;
		this.shelfSample = 0;
		this.shelfPrevInput = 0;
		this.fractionalDelaySample = 0;
		this.prevDelayLength = -1;
		this.delayResetOffset = 0;
	}

	public update(
		synth: Synth,
		instrumentState: InstrumentState,
		tone: Tone,
		stringIndex: number,
		roundedSamplesPerTick: number,
		stringDecayStart: number,
		stringDecayEnd: number
	): void {
		const allPassCenter: number = (2 * Math.PI * Config.pickedStringDispersionCenterFreq) / synth.samplesPerSecond;
		const shelfRadians: number = (2 * Math.PI * Config.pickedStringShelfHz) / synth.samplesPerSecond;
		const decayCurveStart: number = (Math.pow(100, stringDecayStart) - 1) / 99;
		const decayCurveEnd: number = (Math.pow(100, stringDecayEnd) - 1) / 99;

		const prevDelayLength: number = this.prevDelayLength;

		const phaseDeltaStart: number = tone.phaseDeltas[stringIndex];
		const phaseDeltaScale: number = tone.phaseDeltaScales[stringIndex];
		const phaseDeltaEnd: number = phaseDeltaStart * Math.pow(phaseDeltaScale, roundedSamplesPerTick);

		const radiansPerSampleStart: number = Math.PI * 2 * phaseDeltaStart;
		const radiansPerSampleEnd: number = Math.PI * 2 * phaseDeltaEnd;

		const centerHarmonicStart: number = radiansPerSampleStart * 2;
		const centerHarmonicEnd: number = radiansPerSampleEnd * 2;

		const allPassRadiansStart: number = Math.min(
			Math.PI,
			radiansPerSampleStart *
				Config.pickedStringDispersionFreqMult *
				Math.pow(allPassCenter / radiansPerSampleStart, Config.pickedStringDispersionFreqScale)
		);
		const allPassRadiansEnd: number = Math.min(
			Math.PI,
			radiansPerSampleEnd *
				Config.pickedStringDispersionFreqMult *
				Math.pow(allPassCenter / radiansPerSampleEnd, Config.pickedStringDispersionFreqScale)
		);

		const decayRateStart: number = Math.pow(0.5, (decayCurveStart * shelfRadians) / radiansPerSampleStart);
		const decayRateEnd: number = Math.pow(0.5, (decayCurveEnd * shelfRadians) / radiansPerSampleEnd);
		const shelfGainStart: number = Math.pow(decayRateStart, Config.stringDecayRate);
		const shelfGainEnd: number = Math.pow(decayRateEnd, Config.stringDecayRate);
		const expressionDecayStart: number = Math.pow(decayRateStart, 0.002);
		const expressionDecayEnd: number = Math.pow(decayRateEnd, 0.002);

		Synth.tempFilterStartCoefficients.allPass1stOrderInvertPhaseAbove(allPassRadiansStart);
		synth.tempFrequencyResponse.analyze(Synth.tempFilterStartCoefficients, centerHarmonicStart);
		const allPassGStart: number = Synth.tempFilterStartCoefficients.b[0]; /* same as a[1] */
		const allPassPhaseDelayStart: number = -synth.tempFrequencyResponse.angle() / centerHarmonicStart;

		Synth.tempFilterEndCoefficients.allPass1stOrderInvertPhaseAbove(allPassRadiansEnd);
		synth.tempFrequencyResponse.analyze(Synth.tempFilterEndCoefficients, centerHarmonicEnd);
		const allPassGEnd: number = Synth.tempFilterEndCoefficients.b[0]; /* same as a[1] */
		const allPassPhaseDelayEnd: number = -synth.tempFrequencyResponse.angle() / centerHarmonicEnd;

		Synth.tempFilterStartCoefficients.highShelf1stOrder(shelfRadians, shelfGainStart);
		synth.tempFrequencyResponse.analyze(Synth.tempFilterStartCoefficients, centerHarmonicStart);
		const shelfA1Start: number = Synth.tempFilterStartCoefficients.a[1];
		const shelfB0Start: number = Synth.tempFilterStartCoefficients.b[0] * expressionDecayStart;
		const shelfB1Start: number = Synth.tempFilterStartCoefficients.b[1] * expressionDecayStart;
		const shelfPhaseDelayStart: number = -synth.tempFrequencyResponse.angle() / centerHarmonicStart;

		Synth.tempFilterEndCoefficients.highShelf1stOrder(shelfRadians, shelfGainEnd);
		synth.tempFrequencyResponse.analyze(Synth.tempFilterEndCoefficients, centerHarmonicEnd);
		const shelfA1End: number = Synth.tempFilterEndCoefficients.a[1];
		const shelfB0End: number = Synth.tempFilterEndCoefficients.b[0] * expressionDecayEnd;
		const shelfB1End: number = Synth.tempFilterEndCoefficients.b[1] * expressionDecayEnd;
		const shelfPhaseDelayEnd: number = -synth.tempFrequencyResponse.angle() / centerHarmonicEnd;

		const periodLengthStart: number = 1 / phaseDeltaStart;
		const periodLengthEnd: number = 1 / phaseDeltaEnd;
		const minBufferLength: number = Math.ceil(Math.max(periodLengthStart, periodLengthEnd) * 2);
		const delayLength: number = periodLengthStart - allPassPhaseDelayStart - shelfPhaseDelayStart;
		const delayLengthEnd: number = periodLengthEnd - allPassPhaseDelayEnd - shelfPhaseDelayEnd;

		this.prevDelayLength = delayLength;
		this.delayLengthDelta = (delayLengthEnd - delayLength) / roundedSamplesPerTick;
		this.allPassG = allPassGStart;
		this.shelfA1 = shelfA1Start;
		this.shelfB0 = shelfB0Start;
		this.shelfB1 = shelfB1Start;
		this.allPassGDelta = (allPassGEnd - allPassGStart) / roundedSamplesPerTick;
		this.shelfA1Delta = (shelfA1End - shelfA1Start) / roundedSamplesPerTick;
		this.shelfB0Delta = (shelfB0End - shelfB0Start) / roundedSamplesPerTick;
		this.shelfB1Delta = (shelfB1End - shelfB1Start) / roundedSamplesPerTick;

		const pitchChanged: boolean = Math.abs(Math.log2(delayLength / prevDelayLength)) > 0.01;

		const reinitializeImpulse: boolean = this.delayIndex == -1 || pitchChanged;
		if (this.delayLine == null || this.delayLine.length <= minBufferLength) {
			// The delay line buffer will get reused for other tones so might as well
			// start off with a buffer size that is big enough for most notes.
			const likelyMaximumLength: number = Math.ceil(
				(2 * synth.samplesPerSecond) / Instrument.frequencyFromPitch(12)
			);
			const newDelayLine: Float32Array = new Float32Array(
				Synth.fittingPowerOfTwo(Math.max(likelyMaximumLength, minBufferLength))
			);
			if (!reinitializeImpulse && this.delayLine != null) {
				// If the tone has already started but the buffer needs to be reallocated,
				// transfer the old data to the new buffer.
				const oldDelayBufferMask: number = (this.delayLine.length - 1) >> 0;
				const startCopyingFromIndex: number = this.delayIndex + this.delayResetOffset;
				this.delayIndex = this.delayLine.length - this.delayResetOffset;
				for (let i: number = 0; i < this.delayLine.length; i++) {
					newDelayLine[i] = this.delayLine[(startCopyingFromIndex + i) & oldDelayBufferMask];
				}
			}
			this.delayLine = newDelayLine;
		}
		const delayLine: Float32Array = this.delayLine;
		const delayBufferMask: number = (delayLine.length - 1) >> 0;

		if (reinitializeImpulse) {
			// -1 delay index means the tone was reset.
			// Also, if the pitch changed suddenly (e.g. from seamless or arpeggio) then reset the wave.
			this.delayIndex = 0;
			this.allPassSample = 0;
			this.allPassPrevInput = 0;
			this.shelfSample = 0;
			this.shelfPrevInput = 0;
			this.fractionalDelaySample = 0;

			// Clear away a region of the delay buffer for the new impulse.
			const startImpulseFrom: number = -delayLength;
			const startZerosFrom: number = Math.floor(startImpulseFrom - periodLengthStart / 2);
			const stopZerosAt: number = Math.ceil(startZerosFrom + periodLengthStart * 2);
			this.delayResetOffset = stopZerosAt; // And continue clearing the area in front of the delay line.
			for (let i: number = startZerosFrom; i <= stopZerosAt; i++) {
				delayLine[i & delayBufferMask] = 0;
			}

			const impulseWave: Float32Array = instrumentState.wave!;
			const impulseWaveLength: number = impulseWave.length - 1; // The first sample is duplicated at the end, don't double-count it.
			const impulsePhaseDelta: number = impulseWaveLength / periodLengthStart;

			const fadeDuration: number = Math.min(periodLengthStart * 0.2, synth.samplesPerSecond * 0.003);
			const startImpulseFromSample: number = Math.ceil(startImpulseFrom);
			const stopImpulseAt: number = startImpulseFrom + periodLengthStart + fadeDuration;
			const stopImpulseAtSample: number = stopImpulseAt;
			let impulsePhase: number = (startImpulseFromSample - startImpulseFrom) * impulsePhaseDelta;
			let prevWaveIntegral: number = 0;
			for (let i: number = startImpulseFromSample; i <= stopImpulseAtSample; i++) {
				const impulsePhaseInt: number = impulsePhase | 0;
				const index: number = impulsePhaseInt % impulseWaveLength;
				let nextWaveIntegral: number = impulseWave[index];
				const phaseRatio: number = impulsePhase - impulsePhaseInt;
				nextWaveIntegral += (impulseWave[index + 1] - nextWaveIntegral) * phaseRatio;
				const sample: number = (nextWaveIntegral - prevWaveIntegral) / impulsePhaseDelta;
				const fadeIn: number = Math.min(1, (i - startImpulseFrom) / fadeDuration);
				const fadeOut: number = Math.min(1, (stopImpulseAt - i) / fadeDuration);
				const combinedFade: number = fadeIn * fadeOut;
				const curvedFade: number = combinedFade * combinedFade * (3 - 2 * combinedFade); // A cubic sigmoid from 0 to 1.
				delayLine[i & delayBufferMask] += sample * curvedFade;
				prevWaveIntegral = nextWaveIntegral;
				impulsePhase += impulsePhaseDelta;
			}
		}
	}
}
