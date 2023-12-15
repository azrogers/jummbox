import { Dictionary, EnvelopeType, InstrumentType, EffectType, Transition, Unison, Chord, Vibrato, Envelope, AutomationTarget, Config, effectsIncludeTransition, effectsIncludeChord, effectsIncludePitchShift, effectsIncludeDetune, effectsIncludeVibrato, effectsIncludeNoteFilter, effectsIncludeDistortion, effectsIncludeBitcrusher, effectsIncludePanning, effectsIncludeChorus, effectsIncludeEcho, effectsIncludeReverb, FilterType, getDrumWave } from "./SynthConfig";
import { Operator, LegacySettings, Synth, clamp } from "./synth";
import { EnvelopeSettings } from "./Envelope";
import { HarmonicsWave, HarmonicsWaveState } from "./HarmonicsWave";
import { SpectrumWave, SpectrumWaveState } from "./SpectrumWave";
import { FilterControlPoint, FilterSettings } from "./Filter";
import { Deque } from "./Deque";
import { inverseRealFourierTransform, scaleElementsByFactor } from "./FFT";
import { Instrument } from "./Instrument";
import { Tone } from "./Tone";
import { DynamicBiquadFilter } from "./filtering";


export class Instrument
{
	public type: InstrumentType = InstrumentType.chip;
	public preset: number = 0;
	public chipWave: number = 2;
	public chipNoise: number = 1;
	public eqFilter: FilterSettings = new FilterSettings();
	public eqFilterType: boolean = false;
	public eqFilterSimpleCut: number = Config.filterSimpleCutRange - 1;
	public eqFilterSimplePeak: number = 0;
	public noteFilter: FilterSettings = new FilterSettings();
	public noteFilterType: boolean = false;
	public noteFilterSimpleCut: number = Config.filterSimpleCutRange - 1;
	public noteFilterSimplePeak: number = 0;
	public eqSubFilters: (FilterSettings | null)[] = [];
	public noteSubFilters: (FilterSettings | null)[] = [];
	public tmpEqFilterStart: FilterSettings | null;
	public tmpEqFilterEnd: FilterSettings | null;
	public tmpNoteFilterStart: FilterSettings | null;
	public tmpNoteFilterEnd: FilterSettings | null;
	public envelopes: EnvelopeSettings[] = [];
	public fadeIn: number = 0;
	public fadeOut: number = Config.fadeOutNeutral;
	public envelopeCount: number = 0;
	public transition: number = Config.transitions.dictionary["normal"].index;
	public pitchShift: number = 0;
	public detune: number = 0;
	public vibrato: number = 0;
	public interval: number = 0;
	public vibratoDepth: number = 0;
	public vibratoSpeed: number = 10;
	public vibratoDelay: number = 0;
	public vibratoType: number = 0;
	public unison: number = 0;
	public effects: number = 0;
	public chord: number = 1;
	public volume: number = 0;
	public pan: number = Config.panCenter;
	public panDelay: number = 10;
	public arpeggioSpeed: number = 12;
	public fastTwoNoteArp: boolean = false;
	public legacyTieOver: boolean = false;
	public clicklessTransition: boolean = false;
	public aliases: boolean = false;
	public pulseWidth: number = Config.pulseWidthRange;
	public stringSustain: number = 10;
	public distortion: number = 0;
	public bitcrusherFreq: number = 0;
	public bitcrusherQuantization: number = 0;
	public chorus: number = 0;
	public reverb: number = 0;
	public echoSustain: number = 0;
	public echoDelay: number = 0;
	public algorithm: number = 0;
	public feedbackType: number = 0;
	public feedbackAmplitude: number = 0;
	public LFOtime: number = 0;
	public nextLFOtime: number = 0;
	public arpTime: number = 0;
	public customChipWave: Float32Array = new Float32Array(64);
	public customChipWaveIntegral: Float32Array = new Float32Array(65); // One extra element for wrap-around in chipSynth.
	public readonly operators: Operator[] = [];
	public readonly spectrumWave: SpectrumWave;
	public readonly harmonicsWave: HarmonicsWave = new HarmonicsWave();
	public readonly drumsetEnvelopes: number[] = [];
	public readonly drumsetSpectrumWaves: SpectrumWave[] = [];
	public modChannels: number[] = [];
	public modInstruments: number[] = [];
	public modulators: number[] = [];
	public modFilterTypes: number[] = [];
	public invalidModulators: boolean[] = [];
	constructor(isNoiseChannel: boolean, isModChannel: boolean)
	{

		if (isModChannel)
		{
			for (let mod: number = 0; mod < Config.modCount; mod++)
			{
				this.modChannels.push(0);
				this.modInstruments.push(0);
				this.modulators.push(Config.modulators.dictionary["none"].index);
			}
		}

		this.spectrumWave = new SpectrumWave(isNoiseChannel);
		for (let i: number = 0; i < Config.operatorCount; i++)
		{
			this.operators[i] = new Operator(i);
		}
		for (let i: number = 0; i < Config.drumCount; i++)
		{
			this.drumsetEnvelopes[i] = Config.envelopes.dictionary["twang 2"].index;
			this.drumsetSpectrumWaves[i] = new SpectrumWave(true);
		}

		for (let i = 0; i < 64; i++)
		{
			this.customChipWave[i] = 24 - Math.floor(i * (48 / 64));
		}

		let sum: number = 0;
		for (let i: number = 0; i < this.customChipWave.length; i++)
		{
			sum += this.customChipWave[i];
		}
		const average: number = sum / this.customChipWave.length;

		// Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
		let cumulative: number = 0;
		let wavePrev: number = 0;
		for (let i: number = 0; i < this.customChipWave.length; i++)
		{
			cumulative += wavePrev;
			wavePrev = this.customChipWave[i] - average;
			this.customChipWaveIntegral[i] = cumulative;
		}

		// 65th, last sample is for anti-aliasing
		this.customChipWaveIntegral[64] = 0;

	}

	public setTypeAndReset(type: InstrumentType, isNoiseChannel: boolean, isModChannel: boolean): void
	{
		// Mod channels are forced to one type.
		if (isModChannel) type = InstrumentType.mod;
		this.type = type;
		this.preset = type;
		this.volume = 0;
		this.effects = (1 << EffectType.panning); // Panning enabled by default in JB.
		this.chorus = Config.chorusRange - 1;
		this.reverb = 0;
		this.echoSustain = Math.floor((Config.echoSustainRange - 1) * 0.5);
		this.echoDelay = Math.floor((Config.echoDelayRange - 1) * 0.5);
		this.eqFilter.reset();
		this.eqFilterType = false;
		this.eqFilterSimpleCut = Config.filterSimpleCutRange - 1;
		this.eqFilterSimplePeak = 0;
		for (let i: number = 0; i < Config.filterMorphCount; i++)
		{
			this.eqSubFilters[i] = null;
			this.noteSubFilters[i] = null;
		}
		this.noteFilter.reset();
		this.noteFilterType = false;
		this.noteFilterSimpleCut = Config.filterSimpleCutRange - 1;
		this.noteFilterSimplePeak = 0;
		this.distortion = Math.floor((Config.distortionRange - 1) * 0.75);
		this.bitcrusherFreq = Math.floor((Config.bitcrusherFreqRange - 1) * 0.5);
		this.bitcrusherQuantization = Math.floor((Config.bitcrusherQuantizationRange - 1) * 0.5);
		this.pan = Config.panCenter;
		this.panDelay = 10;
		this.pitchShift = Config.pitchShiftCenter;
		this.detune = Config.detuneCenter;
		this.vibrato = 0;
		this.unison = 0;
		this.stringSustain = 10;
		this.clicklessTransition = false;
		this.arpeggioSpeed = 12;
		this.legacyTieOver = false;
		this.aliases = false;
		this.fadeIn = 0;
		this.fadeOut = Config.fadeOutNeutral;
		this.transition = Config.transitions.dictionary["normal"].index;
		this.envelopeCount = 0;
		switch (type)
		{
			case InstrumentType.chip:
				this.chipWave = 2;
				// TODO: enable the chord effect?
				this.chord = Config.chords.dictionary["arpeggio"].index;
				break;
			case InstrumentType.customChipWave:
				this.chipWave = 2;
				this.chord = Config.chords.dictionary["arpeggio"].index;
				for (let i: number = 0; i < 64; i++)
				{
					this.customChipWave[i] = 24 - (Math.floor(i * (48 / 64)));
				}

				let sum: number = 0;
				for (let i: number = 0; i < this.customChipWave.length; i++)
				{
					sum += this.customChipWave[i];
				}
				const average: number = sum / this.customChipWave.length;

				// Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
				let cumulative: number = 0;
				let wavePrev: number = 0;
				for (let i: number = 0; i < this.customChipWave.length; i++)
				{
					cumulative += wavePrev;
					wavePrev = this.customChipWave[i] - average;
					this.customChipWaveIntegral[i] = cumulative;
				}

				this.customChipWaveIntegral[64] = 0;
				break;
			case InstrumentType.fm:
				this.chord = Config.chords.dictionary["custom interval"].index;
				this.algorithm = 0;
				this.feedbackType = 0;
				this.feedbackAmplitude = 0;
				for (let i: number = 0; i < this.operators.length; i++)
				{
					this.operators[i].reset(i);
				}
				break;
			case InstrumentType.noise:
				this.chipNoise = 1;
				this.chord = Config.chords.dictionary["arpeggio"].index;
				break;
			case InstrumentType.spectrum:
				this.chord = Config.chords.dictionary["simultaneous"].index;
				this.spectrumWave.reset(isNoiseChannel);
				break;
			case InstrumentType.drumset:
				this.chord = Config.chords.dictionary["simultaneous"].index;
				for (let i: number = 0; i < Config.drumCount; i++)
				{
					this.drumsetEnvelopes[i] = Config.envelopes.dictionary["twang 2"].index;
					if (this.drumsetSpectrumWaves[i] == undefined)
					{
						this.drumsetSpectrumWaves[i] = new SpectrumWave(true);
					}
					this.drumsetSpectrumWaves[i].reset(isNoiseChannel);
				}
				break;
			case InstrumentType.harmonics:
				this.chord = Config.chords.dictionary["simultaneous"].index;
				this.harmonicsWave.reset();
				break;
			case InstrumentType.pwm:
				this.chord = Config.chords.dictionary["arpeggio"].index;
				this.pulseWidth = Config.pulseWidthRange;
				break;
			case InstrumentType.pickedString:
				this.chord = Config.chords.dictionary["strum"].index;
				this.harmonicsWave.reset();
				break;
			case InstrumentType.mod:
				this.transition = 0;
				this.vibrato = 0;
				this.interval = 0;
				this.effects = 0;
				this.chord = 0;
				this.modChannels = [];
				this.modInstruments = [];
				this.modulators = [];
				for (let mod: number = 0; mod < Config.modCount; mod++)
				{
					this.modChannels.push(-2);
					this.modInstruments.push(0);
					this.modulators.push(Config.modulators.dictionary["none"].index);
					this.invalidModulators[mod] = false;
					this.modFilterTypes[mod] = 0;
				}
				break;
			default:
				throw new Error("Unrecognized instrument type: " + type);
		}
		// Chip/noise instruments had arpeggio and FM had custom interval but neither
		// explicitly saved the chorus setting beforeSeven so enable it here. The effects
		// will otherwise get overridden when reading SongTagCode.startInstrument.
		if (this.chord != Config.chords.dictionary["simultaneous"].index)
		{
			// Enable chord if it was used.
			this.effects = (this.effects | (1 << EffectType.chord));
		}
	}

	// (only) difference for JummBox: Returns whether or not the note filter was chosen for filter conversion.
	public convertLegacySettings(legacySettings: LegacySettings, forceSimpleFilter: boolean): void
	{
		let legacyCutoffSetting: number | undefined = legacySettings.filterCutoff;
		let legacyResonanceSetting: number | undefined = legacySettings.filterResonance;
		let legacyFilterEnv: Envelope | undefined = legacySettings.filterEnvelope;
		let legacyPulseEnv: Envelope | undefined = legacySettings.pulseEnvelope;
		let legacyOperatorEnvelopes: Envelope[] | undefined = legacySettings.operatorEnvelopes;
		let legacyFeedbackEnv: Envelope | undefined = legacySettings.feedbackEnvelope;

		// legacy defaults:
		if (legacyCutoffSetting == undefined) legacyCutoffSetting = (this.type == InstrumentType.chip) ? 6 : 10;
		if (legacyResonanceSetting == undefined) legacyResonanceSetting = 0;
		if (legacyFilterEnv == undefined) legacyFilterEnv = Config.envelopes.dictionary["none"];
		if (legacyPulseEnv == undefined) legacyPulseEnv = Config.envelopes.dictionary[(this.type == InstrumentType.pwm) ? "twang 2" : "none"];
		if (legacyOperatorEnvelopes == undefined) legacyOperatorEnvelopes = [Config.envelopes.dictionary[(this.type == InstrumentType.fm) ? "note size" : "none"], Config.envelopes.dictionary["none"], Config.envelopes.dictionary["none"], Config.envelopes.dictionary["none"]];
		if (legacyFeedbackEnv == undefined) legacyFeedbackEnv = Config.envelopes.dictionary["none"];

		// The "punch" envelope is special: it goes *above* the chosen cutoff. But if the cutoff was already at the max, it couldn't go any higher... except in the current version of BeepBox I raised the max cutoff so it *can* but then it sounds different, so to preserve the original sound let's just remove the punch envelope.
		const legacyFilterCutoffRange: number = 11;
		const cutoffAtMax: boolean = (legacyCutoffSetting == legacyFilterCutoffRange - 1);
		if (cutoffAtMax && legacyFilterEnv.type == EnvelopeType.punch) legacyFilterEnv = Config.envelopes.dictionary["none"];

		const carrierCount: number = Config.algorithms[this.algorithm].carrierCount;
		let noCarriersControlledByNoteSize: boolean = true;
		let allCarriersControlledByNoteSize: boolean = true;
		let noteSizeControlsSomethingElse: boolean = (legacyFilterEnv.type == EnvelopeType.noteSize) || (legacyPulseEnv.type == EnvelopeType.noteSize);
		if (this.type == InstrumentType.fm)
		{
			noteSizeControlsSomethingElse = noteSizeControlsSomethingElse || (legacyFeedbackEnv.type == EnvelopeType.noteSize);
			for (let i: number = 0; i < legacyOperatorEnvelopes.length; i++)
			{
				if (i < carrierCount)
				{
					if (legacyOperatorEnvelopes[i].type != EnvelopeType.noteSize)
					{
						allCarriersControlledByNoteSize = false;
					} else
					{
						noCarriersControlledByNoteSize = false;
					}
				} else
				{
					noteSizeControlsSomethingElse = noteSizeControlsSomethingElse || (legacyOperatorEnvelopes[i].type == EnvelopeType.noteSize);
				}
			}
		}

		this.envelopeCount = 0;

		if (this.type == InstrumentType.fm)
		{
			if (allCarriersControlledByNoteSize && noteSizeControlsSomethingElse)
			{
				this.addEnvelope(Config.instrumentAutomationTargets.dictionary["noteVolume"].index, 0, Config.envelopes.dictionary["note size"].index);
			} else if (noCarriersControlledByNoteSize && !noteSizeControlsSomethingElse)
			{
				this.addEnvelope(Config.instrumentAutomationTargets.dictionary["none"].index, 0, Config.envelopes.dictionary["note size"].index);
			}
		}

		if (legacyFilterEnv.type == EnvelopeType.none)
		{
			this.noteFilter.reset();
			this.noteFilterType = false;
			this.eqFilter.convertLegacySettings(legacyCutoffSetting, legacyResonanceSetting, legacyFilterEnv);
			this.effects &= ~(1 << EffectType.noteFilter);
			if (forceSimpleFilter || this.eqFilterType)
			{
				this.eqFilterType = true;
				this.eqFilterSimpleCut = legacyCutoffSetting;
				this.eqFilterSimplePeak = legacyResonanceSetting;
			}
		} else
		{
			this.eqFilter.reset();

			this.eqFilterType = false;
			this.noteFilterType = false;
			this.noteFilter.convertLegacySettings(legacyCutoffSetting, legacyResonanceSetting, legacyFilterEnv);
			this.effects |= 1 << EffectType.noteFilter;
			this.addEnvelope(Config.instrumentAutomationTargets.dictionary["noteFilterAllFreqs"].index, 0, legacyFilterEnv.index);
			if (forceSimpleFilter || this.noteFilterType)
			{
				this.noteFilterType = true;
				this.noteFilterSimpleCut = legacyCutoffSetting;
				this.noteFilterSimplePeak = legacyResonanceSetting;
			}
		}

		if (legacyPulseEnv.type != EnvelopeType.none)
		{
			this.addEnvelope(Config.instrumentAutomationTargets.dictionary["pulseWidth"].index, 0, legacyPulseEnv.index);
		}

		for (let i: number = 0; i < legacyOperatorEnvelopes.length; i++)
		{
			if (i < carrierCount && allCarriersControlledByNoteSize) continue;
			if (legacyOperatorEnvelopes[i].type != EnvelopeType.none)
			{
				this.addEnvelope(Config.instrumentAutomationTargets.dictionary["operatorAmplitude"].index, i, legacyOperatorEnvelopes[i].index);
			}
		}

		if (legacyFeedbackEnv.type != EnvelopeType.none)
		{
			this.addEnvelope(Config.instrumentAutomationTargets.dictionary["feedbackAmplitude"].index, 0, legacyFeedbackEnv.index);
		}
	}

	public toJsonObject(): Object
	{
		const instrumentObject: any = {
			"type": Config.instrumentTypeNames[this.type],
			"volume": this.volume,
			"eqFilter": this.eqFilter.toJsonObject(),
			"eqFilterType": this.eqFilterType,
			"eqSimpleCut": this.eqFilterSimpleCut,
			"eqSimplePeak": this.eqFilterSimplePeak
		};

		if (this.preset != this.type)
		{
			instrumentObject["preset"] = this.preset;
		}

		for (let i: number = 0; i < Config.filterMorphCount; i++)
		{
			if (this.eqSubFilters[i] != null)
				instrumentObject["eqSubFilters" + i] = this.eqSubFilters[i]!.toJsonObject();
		}

		const effects: string[] = [];
		for (const effect of Config.effectOrder)
		{
			if (this.effects & (1 << effect))
			{
				effects.push(Config.effectNames[effect]);
			}
		}
		instrumentObject["effects"] = effects;


		if (effectsIncludeTransition(this.effects))
		{
			instrumentObject["transition"] = Config.transitions[this.transition].name;
			instrumentObject["clicklessTransition"] = this.clicklessTransition;
		}
		if (effectsIncludeChord(this.effects))
		{
			instrumentObject["chord"] = this.getChord().name;
			instrumentObject["fastTwoNoteArp"] = this.fastTwoNoteArp;
			instrumentObject["arpeggioSpeed"] = this.arpeggioSpeed;
		}
		if (effectsIncludePitchShift(this.effects))
		{
			instrumentObject["pitchShiftSemitones"] = this.pitchShift;
		}
		if (effectsIncludeDetune(this.effects))
		{
			instrumentObject["detuneCents"] = Synth.detuneToCents(this.detune);
		}
		if (effectsIncludeVibrato(this.effects))
		{
			if (this.vibrato == -1)
			{
				this.vibrato = 5;
			}
			if (this.vibrato != 5)
			{
				instrumentObject["vibrato"] = Config.vibratos[this.vibrato].name;
			} else
			{
				instrumentObject["vibrato"] = "custom";
			}
			instrumentObject["vibratoDepth"] = this.vibratoDepth;
			instrumentObject["vibratoDelay"] = this.vibratoDelay;
			instrumentObject["vibratoSpeed"] = this.vibratoSpeed;
			instrumentObject["vibratoType"] = this.vibratoType;
		}
		if (effectsIncludeNoteFilter(this.effects))
		{
			instrumentObject["noteFilterType"] = this.noteFilterType;
			instrumentObject["noteSimpleCut"] = this.noteFilterSimpleCut;
			instrumentObject["noteSimplePeak"] = this.noteFilterSimplePeak;
			instrumentObject["noteFilter"] = this.noteFilter.toJsonObject();

			for (let i: number = 0; i < Config.filterMorphCount; i++)
			{
				if (this.noteSubFilters[i] != null)
					instrumentObject["noteSubFilters" + i] = this.noteSubFilters[i]!.toJsonObject();
			}
		}
		if (effectsIncludeDistortion(this.effects))
		{
			instrumentObject["distortion"] = Math.round(100 * this.distortion / (Config.distortionRange - 1));
			instrumentObject["aliases"] = this.aliases;
		}
		if (effectsIncludeBitcrusher(this.effects))
		{
			instrumentObject["bitcrusherOctave"] = (Config.bitcrusherFreqRange - 1 - this.bitcrusherFreq) * Config.bitcrusherOctaveStep;
			instrumentObject["bitcrusherQuantization"] = Math.round(100 * this.bitcrusherQuantization / (Config.bitcrusherQuantizationRange - 1));
		}
		if (effectsIncludePanning(this.effects))
		{
			instrumentObject["pan"] = Math.round(100 * (this.pan - Config.panCenter) / Config.panCenter);
			instrumentObject["panDelay"] = this.panDelay;
		}
		if (effectsIncludeChorus(this.effects))
		{
			instrumentObject["chorus"] = Math.round(100 * this.chorus / (Config.chorusRange - 1));
		}
		if (effectsIncludeEcho(this.effects))
		{
			instrumentObject["echoSustain"] = Math.round(100 * this.echoSustain / (Config.echoSustainRange - 1));
			instrumentObject["echoDelayBeats"] = Math.round(1000 * (this.echoDelay + 1) * Config.echoDelayStepTicks / (Config.ticksPerPart * Config.partsPerBeat)) / 1000;
		}
		if (effectsIncludeReverb(this.effects))
		{
			instrumentObject["reverb"] = Math.round(100 * this.reverb / (Config.reverbRange - 1));
		}

		if (this.type != InstrumentType.drumset)
		{
			instrumentObject["fadeInSeconds"] = Math.round(10000 * Synth.fadeInSettingToSeconds(this.fadeIn)) / 10000;
			instrumentObject["fadeOutTicks"] = Synth.fadeOutSettingToTicks(this.fadeOut);
		}

		if (this.type == InstrumentType.harmonics || this.type == InstrumentType.pickedString)
		{
			instrumentObject["harmonics"] = [];
			for (let i: number = 0; i < Config.harmonicsControlPoints; i++)
			{
				instrumentObject["harmonics"][i] = Math.round(100 * this.harmonicsWave.harmonics[i] / Config.harmonicsMax);
			}
		}

		if (this.type == InstrumentType.noise)
		{
			instrumentObject["wave"] = Config.chipNoises[this.chipNoise].name;
		} else if (this.type == InstrumentType.spectrum)
		{
			instrumentObject["spectrum"] = [];
			for (let i: number = 0; i < Config.spectrumControlPoints; i++)
			{
				instrumentObject["spectrum"][i] = Math.round(100 * this.spectrumWave.spectrum[i] / Config.spectrumMax);
			}
		} else if (this.type == InstrumentType.drumset)
		{
			instrumentObject["drums"] = [];
			for (let j: number = 0; j < Config.drumCount; j++)
			{
				const spectrum: number[] = [];
				for (let i: number = 0; i < Config.spectrumControlPoints; i++)
				{
					spectrum[i] = Math.round(100 * this.drumsetSpectrumWaves[j].spectrum[i] / Config.spectrumMax);
				}
				instrumentObject["drums"][j] = {
					"filterEnvelope": this.getDrumsetEnvelope(j).name,
					"spectrum": spectrum,
				};
			}
		} else if (this.type == InstrumentType.chip)
		{
			instrumentObject["wave"] = Config.chipWaves[this.chipWave].name;
			instrumentObject["unison"] = Config.unisons[this.unison].name;
		} else if (this.type == InstrumentType.pwm)
		{
			instrumentObject["pulseWidth"] = this.pulseWidth;
		} else if (this.type == InstrumentType.pickedString)
		{
			instrumentObject["unison"] = Config.unisons[this.unison].name;
			instrumentObject["stringSustain"] = Math.round(100 * this.stringSustain / (Config.stringSustainRange - 1));
		} else if (this.type == InstrumentType.harmonics)
		{
			instrumentObject["unison"] = Config.unisons[this.unison].name;
		} else if (this.type == InstrumentType.fm)
		{
			const operatorArray: Object[] = [];
			for (const operator of this.operators)
			{
				operatorArray.push({
					"frequency": Config.operatorFrequencies[operator.frequency].name,
					"amplitude": operator.amplitude,
					"waveform": Config.operatorWaves[operator.waveform].name,
					"pulseWidth": operator.pulseWidth,
				});
			}
			instrumentObject["algorithm"] = Config.algorithms[this.algorithm].name;
			instrumentObject["feedbackType"] = Config.feedbacks[this.feedbackType].name;
			instrumentObject["feedbackAmplitude"] = this.feedbackAmplitude;
			instrumentObject["operators"] = operatorArray;
		} else if (this.type == InstrumentType.customChipWave)
		{
			instrumentObject["wave"] = Config.chipWaves[this.chipWave].name;
			instrumentObject["unison"] = Config.unisons[this.unison].name;
			instrumentObject["customChipWave"] = new Float64Array(64);
			instrumentObject["customChipWaveIntegral"] = new Float64Array(65);
			for (let i: number = 0; i < this.customChipWave.length; i++)
			{
				instrumentObject["customChipWave"][i] = this.customChipWave[i];
				// Meh, waste of space and can be inaccurate. It will be recalc'ed when instrument loads.
				//instrumentObject["customChipWaveIntegral"][i] = this.customChipWaveIntegral[i];
			}
		} else if (this.type == InstrumentType.mod)
		{
			instrumentObject["modChannels"] = [];
			instrumentObject["modInstruments"] = [];
			instrumentObject["modSettings"] = [];
			instrumentObject["modStatuses"] = [];
			for (let mod: number = 0; mod < Config.modCount; mod++)
			{
				instrumentObject["modChannels"][mod] = this.modChannels[mod];
				instrumentObject["modInstruments"][mod] = this.modInstruments[mod];
				instrumentObject["modSettings"][mod] = this.modulators[mod];
			}
		} else
		{
			throw new Error("Unrecognized instrument type");
		}

		const envelopes: any[] = [];
		for (let i = 0; i < this.envelopeCount; i++)
		{
			envelopes.push(this.envelopes[i].toJsonObject());
		}
		instrumentObject["envelopes"] = envelopes;

		return instrumentObject;
	}


	public fromJsonObject(instrumentObject: any, isNoiseChannel: boolean, isModChannel: boolean, useSlowerRhythm: boolean, useFastTwoNoteArp: boolean, legacyGlobalReverb: number = 0): void
	{
		if (instrumentObject == undefined) instrumentObject = {};

		let type: InstrumentType = Config.instrumentTypeNames.indexOf(instrumentObject["type"]);
		if (<any>type == -1) type = isModChannel ? InstrumentType.mod : (isNoiseChannel ? InstrumentType.noise : InstrumentType.chip);
		this.setTypeAndReset(type, isNoiseChannel, isModChannel);

		if (instrumentObject["preset"] != undefined)
		{
			this.preset = instrumentObject["preset"] >>> 0;
		}

		if (instrumentObject["volume"] != undefined)
		{
			this.volume = clamp(-Config.volumeRange / 2, (Config.volumeRange / 2) + 1, instrumentObject["volume"] | 0);
		} else
		{
			this.volume = 0;
		}

		if (Array.isArray(instrumentObject["effects"]))
		{
			let effects: number = 0;
			for (let i: number = 0; i < instrumentObject["effects"].length; i++)
			{
				effects = effects | (1 << Config.effectNames.indexOf(instrumentObject["effects"][i]));
			}
			this.effects = (effects & ((1 << EffectType.length) - 1));
		} else
		{
			// The index of these names is reinterpreted as a bitfield, which relies on reverb and chorus being the first effects!
			const legacyEffectsNames: string[] = ["none", "reverb", "chorus", "chorus & reverb"];
			this.effects = legacyEffectsNames.indexOf(instrumentObject["effects"]);
			if (this.effects == -1) this.effects = (this.type == InstrumentType.noise) ? 0 : 1;
		}

		this.transition = Config.transitions.dictionary["normal"].index; // default value.
		const transitionProperty: any = instrumentObject["transition"] || instrumentObject["envelope"]; // the transition property used to be called envelope, so check that too.
		if (transitionProperty != undefined)
		{
			let transition: Transition | undefined = Config.transitions.dictionary[transitionProperty];
			if (instrumentObject["fadeInSeconds"] == undefined || instrumentObject["fadeOutTicks"] == undefined)
			{
				const legacySettings = (<any>{
					"binary": { transition: "interrupt", fadeInSeconds: 0, fadeOutTicks: -1 },
					"seamless": { transition: "interrupt", fadeInSeconds: 0, fadeOutTicks: -1 },
					"sudden": { transition: "normal", fadeInSeconds: 0, fadeOutTicks: -3 },
					"hard": { transition: "normal", fadeInSeconds: 0, fadeOutTicks: -3 },
					"smooth": { transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
					"soft": { transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
					// Note that the old slide transition has the same name as a new slide transition that is different.
					// Only apply legacy settings if the instrument JSON was created before, based on the presence
					// of the fade in/out fields.
					"slide": { transition: "slide in pattern", fadeInSeconds: 0.025, fadeOutTicks: -3 },
					"cross fade": { transition: "normal", fadeInSeconds: 0.04, fadeOutTicks: 6 },
					"hard fade": { transition: "normal", fadeInSeconds: 0, fadeOutTicks: 48 },
					"medium fade": { transition: "normal", fadeInSeconds: 0.0125, fadeOutTicks: 72 },
					"soft fade": { transition: "normal", fadeInSeconds: 0.06, fadeOutTicks: 96 },
				})[transitionProperty];
				if (legacySettings != undefined)
				{
					transition = Config.transitions.dictionary[legacySettings.transition];
					// These may be overridden below.
					this.fadeIn = Synth.secondsToFadeInSetting(legacySettings.fadeInSeconds);
					this.fadeOut = Synth.ticksToFadeOutSetting(legacySettings.fadeOutTicks);
				}
			}
			if (transition != undefined) this.transition = transition.index;

			if (this.transition != Config.transitions.dictionary["normal"].index)
			{
				// Enable transition if it was used.
				this.effects = (this.effects | (1 << EffectType.transition));
			}
		}

		// Overrides legacy settings in transition above.
		if (instrumentObject["fadeInSeconds"] != undefined)
		{
			this.fadeIn = Synth.secondsToFadeInSetting(+instrumentObject["fadeInSeconds"]);
		}
		if (instrumentObject["fadeOutTicks"] != undefined)
		{
			this.fadeOut = Synth.ticksToFadeOutSetting(+instrumentObject["fadeOutTicks"]);
		}

		{
			// Note that the chord setting may be overridden by instrumentObject["chorus"] below.
			const chordProperty: any = instrumentObject["chord"];
			const legacyChordNames: Dictionary<string> = { "harmony": "simultaneous" };
			const chord: Chord | undefined = Config.chords.dictionary[legacyChordNames[chordProperty]] || Config.chords.dictionary[chordProperty];
			if (chord != undefined)
			{
				this.chord = chord.index;
			} else
			{
				// Different instruments have different default chord types based on historical behaviour.
				if (this.type == InstrumentType.noise)
				{
					this.chord = Config.chords.dictionary["arpeggio"].index;
				} else if (this.type == InstrumentType.pickedString)
				{
					this.chord = Config.chords.dictionary["strum"].index;
				} else if (this.type == InstrumentType.chip)
				{
					this.chord = Config.chords.dictionary["arpeggio"].index;
				} else if (this.type == InstrumentType.fm)
				{
					this.chord = Config.chords.dictionary["custom interval"].index;
				} else
				{
					this.chord = Config.chords.dictionary["simultaneous"].index;
				}
			}
		}

		this.unison = Config.unisons.dictionary["none"].index; // default value.
		const unisonProperty: any = instrumentObject["unison"] || instrumentObject["interval"] || instrumentObject["chorus"]; // The unison property has gone by various names in the past.
		if (unisonProperty != undefined)
		{
			const legacyChorusNames: Dictionary<string> = { "union": "none", "fifths": "fifth", "octaves": "octave" };
			const unison: Unison | undefined = Config.unisons.dictionary[legacyChorusNames[unisonProperty]] || Config.unisons.dictionary[unisonProperty];
			if (unison != undefined) this.unison = unison.index;
		}
		if (instrumentObject["chorus"] == "custom harmony")
		{
			// The original chorus setting had an option that now maps to two different settings. Override those if necessary.
			this.unison = Config.unisons.dictionary["hum"].index;
			this.chord = Config.chords.dictionary["custom interval"].index;
		}
		if (this.chord != Config.chords.dictionary["simultaneous"].index && !Array.isArray(instrumentObject["effects"]))
		{
			// Enable chord if it was used.
			this.effects = (this.effects | (1 << EffectType.chord));
		}

		if (instrumentObject["pitchShiftSemitones"] != undefined)
		{
			this.pitchShift = clamp(0, Config.pitchShiftRange, Math.round(+instrumentObject["pitchShiftSemitones"]));
		}
		if (instrumentObject["detuneCents"] != undefined)
		{
			this.detune = clamp(Config.detuneMin, Config.detuneMax + 1, Math.round(Synth.centsToDetune(+instrumentObject["detuneCents"])));
		}

		this.vibrato = Config.vibratos.dictionary["none"].index; // default value.
		const vibratoProperty: any = instrumentObject["vibrato"] || instrumentObject["effect"]; // The vibrato property was previously called "effect", not to be confused with the current "effects".
		if (vibratoProperty != undefined)
		{

			const legacyVibratoNames: Dictionary<string> = { "vibrato light": "light", "vibrato delayed": "delayed", "vibrato heavy": "heavy" };
			const vibrato: Vibrato | undefined = Config.vibratos.dictionary[legacyVibratoNames[unisonProperty]] || Config.vibratos.dictionary[vibratoProperty];
			if (vibrato != undefined)
				this.vibrato = vibrato.index;
			else if (vibratoProperty == "custom")
				this.vibrato = Config.vibratos.length; // custom

			if (this.vibrato == Config.vibratos.length)
			{
				this.vibratoDepth = instrumentObject["vibratoDepth"];
				this.vibratoSpeed = instrumentObject["vibratoSpeed"];
				this.vibratoDelay = instrumentObject["vibratoDelay"];
				this.vibratoType = instrumentObject["vibratoType"];
			}
			else
			{ // Set defaults for the vibrato profile
				this.vibratoDepth = Config.vibratos[this.vibrato].amplitude;
				this.vibratoDelay = Config.vibratos[this.vibrato].delayTicks / 2;
				this.vibratoSpeed = 10; // default;
				this.vibratoType = Config.vibratos[this.vibrato].type;
			}

			// Old songs may have a vibrato effect without explicitly enabling it.
			if (vibrato != Config.vibratos.dictionary["none"])
			{
				this.effects = (this.effects | (1 << EffectType.vibrato));
			}
		}

		if (instrumentObject["pan"] != undefined)
		{
			this.pan = clamp(0, Config.panMax + 1, Math.round(Config.panCenter + (instrumentObject["pan"] | 0) * Config.panCenter / 100));

			// Old songs may have a panning effect without explicitly enabling it.
			if (this.pan != Config.panCenter)
			{
				this.effects = (this.effects | (1 << EffectType.panning));
			}
		} else
		{
			this.pan = Config.panCenter;
			// Still enabling pan effect, to make it a default
			this.effects = (this.effects | (1 << EffectType.panning));
		}

		if (instrumentObject["panDelay"] != undefined)
		{
			this.panDelay = (instrumentObject["panDelay"] | 0);
		} else
		{
			this.panDelay = 10;
		}

		if (instrumentObject["detune"] != undefined)
		{
			this.detune = clamp(Config.detuneMin, Config.detuneMax + 1, (instrumentObject["detune"] | 0));
		}
		else if (instrumentObject["detuneCents"] == undefined)
		{
			this.detune = Config.detuneCenter;
		}

		if (instrumentObject["distortion"] != undefined)
		{
			this.distortion = clamp(0, Config.distortionRange, Math.round((Config.distortionRange - 1) * (instrumentObject["distortion"] | 0) / 100));
		}

		if (instrumentObject["bitcrusherOctave"] != undefined)
		{
			this.bitcrusherFreq = Config.bitcrusherFreqRange - 1 - (+instrumentObject["bitcrusherOctave"]) / Config.bitcrusherOctaveStep;
		}
		if (instrumentObject["bitcrusherQuantization"] != undefined)
		{
			this.bitcrusherQuantization = clamp(0, Config.bitcrusherQuantizationRange, Math.round((Config.bitcrusherQuantizationRange - 1) * (instrumentObject["bitcrusherQuantization"] | 0) / 100));
		}

		if (instrumentObject["echoSustain"] != undefined)
		{
			this.echoSustain = clamp(0, Config.echoSustainRange, Math.round((Config.echoSustainRange - 1) * (instrumentObject["echoSustain"] | 0) / 100));
		}
		if (instrumentObject["echoDelayBeats"] != undefined)
		{
			this.echoDelay = clamp(0, Config.echoDelayRange, Math.round((+instrumentObject["echoDelayBeats"]) * (Config.ticksPerPart * Config.partsPerBeat) / Config.echoDelayStepTicks - 1));
		}

		if (!isNaN(instrumentObject["chorus"]))
		{
			this.chorus = clamp(0, Config.chorusRange, Math.round((Config.chorusRange - 1) * (instrumentObject["chorus"] | 0) / 100));
		}

		if (instrumentObject["reverb"] != undefined)
		{
			this.reverb = clamp(0, Config.reverbRange, Math.round((Config.reverbRange - 1) * (instrumentObject["reverb"] | 0) / 100));
		} else
		{
			this.reverb = legacyGlobalReverb;
		}

		if (instrumentObject["pulseWidth"] != undefined)
		{
			this.pulseWidth = clamp(1, Config.pulseWidthRange + 1, Math.round(instrumentObject["pulseWidth"]));
		} else
		{
			this.pulseWidth = Config.pulseWidthRange;
		}

		if (instrumentObject["harmonics"] != undefined)
		{
			for (let i: number = 0; i < Config.harmonicsControlPoints; i++)
			{
				this.harmonicsWave.harmonics[i] = Math.max(0, Math.min(Config.harmonicsMax, Math.round(Config.harmonicsMax * (+instrumentObject["harmonics"][i]) / 100)));
			}
			this.harmonicsWave.markCustomWaveDirty();
		} else
		{
			this.harmonicsWave.reset();
		}

		if (instrumentObject["spectrum"] != undefined)
		{
			for (let i: number = 0; i < Config.spectrumControlPoints; i++)
			{
				this.spectrumWave.spectrum[i] = Math.max(0, Math.min(Config.spectrumMax, Math.round(Config.spectrumMax * (+instrumentObject["spectrum"][i]) / 100)));
			}
		} else
		{
			this.spectrumWave.reset(isNoiseChannel);
		}

		if (instrumentObject["stringSustain"] != undefined)
		{
			this.stringSustain = clamp(0, Config.stringSustainRange, Math.round((Config.stringSustainRange - 1) * (instrumentObject["stringSustain"] | 0) / 100));
		} else
		{
			this.stringSustain = 10;
		}

		if (this.type == InstrumentType.noise)
		{
			this.chipNoise = Config.chipNoises.findIndex(wave => wave.name == instrumentObject["wave"]);
			if (this.chipNoise == -1) this.chipNoise = 1;
		}

		const legacyEnvelopeNames: Dictionary<string> = { "custom": "note size", "steady": "none", "pluck 1": "twang 1", "pluck 2": "twang 2", "pluck 3": "twang 3" };
		const getEnvelope = (name: any): Envelope | undefined => (legacyEnvelopeNames[name] != undefined) ? Config.envelopes.dictionary[legacyEnvelopeNames[name]] : Config.envelopes.dictionary[name];

		if (this.type == InstrumentType.drumset)
		{
			if (instrumentObject["drums"] != undefined)
			{
				for (let j: number = 0; j < Config.drumCount; j++)
				{
					const drum: any = instrumentObject["drums"][j];
					if (drum == undefined) continue;

					this.drumsetEnvelopes[j] = Config.envelopes.dictionary["twang 2"].index; // default value.
					if (drum["filterEnvelope"] != undefined)
					{
						const envelope: Envelope | undefined = getEnvelope(drum["filterEnvelope"]);
						if (envelope != undefined) this.drumsetEnvelopes[j] = envelope.index;
					}
					if (drum["spectrum"] != undefined)
					{
						for (let i: number = 0; i < Config.spectrumControlPoints; i++)
						{
							this.drumsetSpectrumWaves[j].spectrum[i] = Math.max(0, Math.min(Config.spectrumMax, Math.round(Config.spectrumMax * (+drum["spectrum"][i]) / 100)));
						}
					}
				}
			}
		}

		if (this.type == InstrumentType.chip)
		{
			const legacyWaveNames: Dictionary<number> = { "triangle": 1, "square": 2, "pulse wide": 3, "pulse narrow": 4, "sawtooth": 5, "double saw": 6, "double pulse": 7, "spiky": 8, "plateau": 0 };
			this.chipWave = legacyWaveNames[instrumentObject["wave"]] != undefined ? legacyWaveNames[instrumentObject["wave"]] : Config.chipWaves.findIndex(wave => wave.name == instrumentObject["wave"]);
			if (this.chipWave == -1) this.chipWave = 1;
		}

		if (this.type == InstrumentType.fm)
		{
			this.algorithm = Config.algorithms.findIndex(algorithm => algorithm.name == instrumentObject["algorithm"]);
			if (this.algorithm == -1) this.algorithm = 0;
			this.feedbackType = Config.feedbacks.findIndex(feedback => feedback.name == instrumentObject["feedbackType"]);
			if (this.feedbackType == -1) this.feedbackType = 0;
			if (instrumentObject["feedbackAmplitude"] != undefined)
			{
				this.feedbackAmplitude = clamp(0, Config.operatorAmplitudeMax + 1, instrumentObject["feedbackAmplitude"] | 0);
			} else
			{
				this.feedbackAmplitude = 0;
			}

			for (let j: number = 0; j < Config.operatorCount; j++)
			{
				const operator: Operator = this.operators[j];
				let operatorObject: any = undefined;
				if (instrumentObject["operators"] != undefined) operatorObject = instrumentObject["operators"][j];
				if (operatorObject == undefined) operatorObject = {};

				operator.frequency = Config.operatorFrequencies.findIndex(freq => freq.name == operatorObject["frequency"]);
				if (operator.frequency == -1) operator.frequency = 0;
				if (operatorObject["amplitude"] != undefined)
				{
					operator.amplitude = clamp(0, Config.operatorAmplitudeMax + 1, operatorObject["amplitude"] | 0);
				} else
				{
					operator.amplitude = 0;
				}
				if (operatorObject["waveform"] != undefined)
				{
					operator.waveform = Config.operatorWaves.findIndex(wave => wave.name == operatorObject["waveform"]);
					if (operator.waveform == -1)
					{
						// GoldBox compatibility
						if (operatorObject["waveform"] == "square")
						{
							operator.waveform = Config.operatorWaves.dictionary["pulse width"].index;
							operator.pulseWidth = 5;
						} else
						{
							operator.waveform = 0;
						}

					}
				} else
				{
					operator.waveform = 0;
				}
				if (operatorObject["pulseWidth"] != undefined)
				{
					operator.pulseWidth = operatorObject["pulseWidth"] | 0;
				} else
				{
					operator.pulseWidth = 5;
				}
			}
		}
		else if (this.type == InstrumentType.customChipWave)
		{
			if (instrumentObject["customChipWave"])
			{

				for (let i: number = 0; i < 64; i++)
				{
					this.customChipWave[i] = instrumentObject["customChipWave"][i];
				}


				let sum: number = 0;
				for (let i: number = 0; i < this.customChipWave.length; i++)
				{
					sum += this.customChipWave[i];
				}
				const average: number = sum / this.customChipWave.length;

				// Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
				let cumulative: number = 0;
				let wavePrev: number = 0;
				for (let i: number = 0; i < this.customChipWave.length; i++)
				{
					cumulative += wavePrev;
					wavePrev = this.customChipWave[i] - average;
					this.customChipWaveIntegral[i] = cumulative;
				}

				// 65th, last sample is for anti-aliasing
				this.customChipWaveIntegral[64] = 0;
			}
		} else if (this.type == InstrumentType.mod)
		{
			if (instrumentObject["modChannels"] != undefined)
			{
				for (let mod: number = 0; mod < Config.modCount; mod++)
				{
					this.modChannels[mod] = instrumentObject["modChannels"][mod];
					this.modInstruments[mod] = instrumentObject["modInstruments"][mod];
					this.modulators[mod] = instrumentObject["modSettings"][mod];
				}
			}
		}

		if (this.type != InstrumentType.mod)
		{
			// Arpeggio speed
			if (this.chord == Config.chords.dictionary["arpeggio"].index && instrumentObject["arpeggioSpeed"] != undefined)
			{
				this.arpeggioSpeed = instrumentObject["arpeggioSpeed"];
			}
			else
			{
				this.arpeggioSpeed = (useSlowerRhythm) ? 9 : 12; // Decide whether to import arps as x3/4 speed
			}

			if (instrumentObject["fastTwoNoteArp"] != undefined)
			{
				this.fastTwoNoteArp = instrumentObject["fastTwoNoteArp"];
			}
			else
			{
				this.fastTwoNoteArp = useFastTwoNoteArp;
			}

			if (instrumentObject["clicklessTransition"] != undefined)
			{
				this.clicklessTransition = instrumentObject["clicklessTransition"];
			}
			else
			{
				this.clicklessTransition = false;
			}

			if (instrumentObject["aliases"] != undefined)
			{
				this.aliases = instrumentObject["aliases"];
			}
			else
			{
				this.aliases = false;
			}

			if (instrumentObject["noteFilterType"] != undefined)
			{
				this.noteFilterType = instrumentObject["noteFilterType"];
			}
			if (instrumentObject["noteSimpleCut"] != undefined)
			{
				this.noteFilterSimpleCut = instrumentObject["noteSimpleCut"];
			}
			if (instrumentObject["noteSimplePeak"] != undefined)
			{
				this.noteFilterSimplePeak = instrumentObject["noteSimplePeak"];
			}
			if (instrumentObject["noteFilter"] != undefined)
			{
				this.noteFilter.fromJsonObject(instrumentObject["noteFilter"]);
			} else
			{
				this.noteFilter.reset();
			}
			for (let i: number = 0; i < Config.filterMorphCount; i++)
			{
				if (Array.isArray(instrumentObject["noteSubFilters" + i]))
				{
					this.noteSubFilters[i] = new FilterSettings();
					this.noteSubFilters[i]!.fromJsonObject(instrumentObject["noteSubFilters" + i]);
				}
			}
			if (instrumentObject["eqFilterType"] != undefined)
			{
				this.eqFilterType = instrumentObject["eqFilterType"];
			}
			if (instrumentObject["eqSimpleCut"] != undefined)
			{
				this.eqFilterSimpleCut = instrumentObject["eqSimpleCut"];
			}
			if (instrumentObject["eqSimplePeak"] != undefined)
			{
				this.eqFilterSimplePeak = instrumentObject["eqSimplePeak"];
			}
			if (Array.isArray(instrumentObject["eqFilter"]))
			{
				this.eqFilter.fromJsonObject(instrumentObject["eqFilter"]);
			} else
			{
				this.eqFilter.reset();

				const legacySettings: LegacySettings = {};

				// Try converting from legacy filter settings.
				const filterCutoffMaxHz: number = 8000;
				const filterCutoffRange: number = 11;
				const filterResonanceRange: number = 8;
				if (instrumentObject["filterCutoffHz"] != undefined)
				{
					legacySettings.filterCutoff = clamp(0, filterCutoffRange, Math.round((filterCutoffRange - 1) + 2 * Math.log((instrumentObject["filterCutoffHz"] | 0) / filterCutoffMaxHz) / Math.LN2));
				} else
				{
					legacySettings.filterCutoff = (this.type == InstrumentType.chip) ? 6 : 10;
				}
				if (instrumentObject["filterResonance"] != undefined)
				{
					legacySettings.filterResonance = clamp(0, filterResonanceRange, Math.round((filterResonanceRange - 1) * (instrumentObject["filterResonance"] | 0) / 100));
				} else
				{
					legacySettings.filterResonance = 0;
				}

				legacySettings.filterEnvelope = getEnvelope(instrumentObject["filterEnvelope"]);
				legacySettings.pulseEnvelope = getEnvelope(instrumentObject["pulseEnvelope"]);
				legacySettings.feedbackEnvelope = getEnvelope(instrumentObject["feedbackEnvelope"]);
				if (Array.isArray(instrumentObject["operators"]))
				{
					legacySettings.operatorEnvelopes = [];
					for (let j: number = 0; j < Config.operatorCount; j++)
					{
						let envelope: Envelope | undefined;
						if (instrumentObject["operators"][j] != undefined)
						{
							envelope = getEnvelope(instrumentObject["operators"][j]["envelope"]);
						}
						legacySettings.operatorEnvelopes[j] = (envelope != undefined) ? envelope : Config.envelopes.dictionary["none"];
					}
				}

				// Try converting from even older legacy filter settings.
				if (instrumentObject["filter"] != undefined)
				{
					const legacyToCutoff: number[] = [10, 6, 3, 0, 8, 5, 2];
					const legacyToEnvelope: string[] = ["none", "none", "none", "none", "decay 1", "decay 2", "decay 3"];
					const filterNames: string[] = ["none", "bright", "medium", "soft", "decay bright", "decay medium", "decay soft"];
					const oldFilterNames: Dictionary<number> = { "sustain sharp": 1, "sustain medium": 2, "sustain soft": 3, "decay sharp": 4 };
					let legacyFilter: number = oldFilterNames[instrumentObject["filter"]] != undefined ? oldFilterNames[instrumentObject["filter"]] : filterNames.indexOf(instrumentObject["filter"]);
					if (legacyFilter == -1) legacyFilter = 0;
					legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
					legacySettings.filterEnvelope = getEnvelope(legacyToEnvelope[legacyFilter]);
					legacySettings.filterResonance = 0;
				}

				this.convertLegacySettings(legacySettings, true);
			}

			for (let i: number = 0; i < Config.filterMorphCount; i++)
			{
				if (Array.isArray(instrumentObject["eqSubFilters" + i]))
				{
					this.eqSubFilters[i] = new FilterSettings();
					this.eqSubFilters[i]!.fromJsonObject(instrumentObject["eqSubFilters" + i]);
				}
			}

			if (Array.isArray(instrumentObject["envelopes"]))
			{
				const envelopeArray: any[] = instrumentObject["envelopes"];
				for (let i = 0; i < envelopeArray.length; i++)
				{
					if (this.envelopeCount >= Config.maxEnvelopeCount) break;
					const tempEnvelope: EnvelopeSettings = new EnvelopeSettings();
					tempEnvelope.fromJsonObject(envelopeArray[i]);
					this.addEnvelope(tempEnvelope.target, tempEnvelope.index, tempEnvelope.envelope);
				}
			}
		}
	}

	public static frequencyFromPitch(pitch: number): number
	{
		return 440 * Math.pow(2, (pitch - 69) / 12);
	}

	public addEnvelope(target: number, index: number, envelope: number): void
	{
		let makeEmpty: boolean = false;
		if (!this.supportsEnvelopeTarget(target, index)) makeEmpty = true;
		if (this.envelopeCount >= Config.maxEnvelopeCount) throw new Error();
		while (this.envelopes.length <= this.envelopeCount) this.envelopes[this.envelopes.length] = new EnvelopeSettings();
		const envelopeSettings: EnvelopeSettings = this.envelopes[this.envelopeCount];
		envelopeSettings.target = makeEmpty ? Config.instrumentAutomationTargets.dictionary["none"].index : target;
		envelopeSettings.index = makeEmpty ? 0 : index;
		envelopeSettings.envelope = envelope;
		this.envelopeCount++;
	}

	public supportsEnvelopeTarget(target: number, index: number): boolean
	{
		const automationTarget: AutomationTarget = Config.instrumentAutomationTargets[target];
		if (index >= automationTarget.maxCount)
		{
			return false;
		}
		if (automationTarget.compatibleInstruments != null && automationTarget.compatibleInstruments.indexOf(this.type) == -1)
		{
			return false;
		}
		if (automationTarget.effect != null && (this.effects & (1 << automationTarget.effect)) == 0)
		{
			return false;
		}
		if (automationTarget.isFilter)
		{
			//if (automationTarget.perNote) {
			let useControlPointCount: number = this.noteFilter.controlPointCount;
			if (this.noteFilterType)
				useControlPointCount = 1;
			if (index >= useControlPointCount) return false;
			//} else {
			//	if (index >= this.eqFilter.controlPointCount)   return false;
			//}
		}
		return true;
	}

	public clearInvalidEnvelopeTargets(): void
	{
		for (let envelopeIndex: number = 0; envelopeIndex < this.envelopeCount; envelopeIndex++)
		{
			const target: number = this.envelopes[envelopeIndex].target;
			const index: number = this.envelopes[envelopeIndex].index;
			if (!this.supportsEnvelopeTarget(target, index))
			{
				this.envelopes[envelopeIndex].target = Config.instrumentAutomationTargets.dictionary["none"].index;
				this.envelopes[envelopeIndex].index = 0;
			}
		}
	}

	public getTransition(): Transition
	{
		return effectsIncludeTransition(this.effects) ? Config.transitions[this.transition] :
			(this.type == InstrumentType.mod ? Config.transitions.dictionary["interrupt"] : Config.transitions.dictionary["normal"]);
	}

	public getFadeInSeconds(): number
	{
		return (this.type == InstrumentType.drumset) ? 0 : Synth.fadeInSettingToSeconds(this.fadeIn);
	}

	public getFadeOutTicks(): number
	{
		return (this.type == InstrumentType.drumset) ? Config.drumsetFadeOutTicks : Synth.fadeOutSettingToTicks(this.fadeOut);
	}

	public getChord(): Chord
	{
		return effectsIncludeChord(this.effects) ? Config.chords[this.chord] : Config.chords.dictionary["simultaneous"];
	}

	public getDrumsetEnvelope(pitch: number): Envelope
	{
		if (this.type != InstrumentType.drumset) throw new Error("Can't getDrumsetEnvelope() for non-drumset.");
		return Config.envelopes[this.drumsetEnvelopes[pitch]];
	}
}
export class InstrumentState
{
	public instrument: Instrument;

	public awake: boolean = false; // Whether the instrument's effects-processing loop should continue.
	public computed: boolean = false; // Whether the effects-processing parameters are up-to-date for the current synth run.
	public tonesAddedInThisTick: boolean = false; // Whether any instrument tones are currently active.
	public flushingDelayLines: boolean = false; // If no tones were active recently, enter a mode where the delay lines are filled with zeros to reset them for later use.
	public deactivateAfterThisTick: boolean = false; // Whether the instrument is ready to be deactivated because the delay lines, if any, are fully zeroed.
	public attentuationProgress: number = 0; // How long since an active tone introduced an input signal to the delay lines, normalized from 0 to 1 based on how long to wait until the delay lines signal will have audibly dissapated.
	public flushedSamples: number = 0; // How many delay line samples have been flushed to zero.
	public readonly activeTones: Deque<Tone> = new Deque<Tone>();
	public readonly activeModTones: Deque<Tone> = new Deque<Tone>();
	public readonly releasedTones: Deque<Tone> = new Deque<Tone>(); // Tones that are in the process of fading out after the corresponding notes ended.
	public readonly liveInputTones: Deque<Tone> = new Deque<Tone>(); // Tones that are initiated by a source external to the loaded song data.

	public type: InstrumentType = InstrumentType.chip;
	public synthesizer: Function | null = null;
	public wave: Float32Array | null = null;
	public noisePitchFilterMult: number = 1;
	public unison: Unison | null = null;
	public chord: Chord | null = null;
	public effects: number = 0;

	public volumeScale: number = 0;
	public aliases: boolean = false;

	public eqFilterVolume: number = 1;
	public eqFilterVolumeDelta: number = 0;
	public mixVolume: number = 1;
	public mixVolumeDelta: number = 0;
	public delayInputMult: number = 0;
	public delayInputMultDelta: number = 0;

	public distortion: number = 0;
	public distortionDelta: number = 0;
	public distortionDrive: number = 0;
	public distortionDriveDelta: number = 0;
	public distortionFractionalInput1: number = 0;
	public distortionFractionalInput2: number = 0;
	public distortionFractionalInput3: number = 0;
	public distortionPrevInput: number = 0;
	public distortionNextOutput: number = 0;

	public bitcrusherPrevInput: number = 0;
	public bitcrusherCurrentOutput: number = 0;
	public bitcrusherPhase: number = 1;
	public bitcrusherPhaseDelta: number = 0;
	public bitcrusherPhaseDeltaScale: number = 1;
	public bitcrusherScale: number = 1;
	public bitcrusherScaleScale: number = 1;
	public bitcrusherFoldLevel: number = 1;
	public bitcrusherFoldLevelScale: number = 1;

	public readonly eqFilters: DynamicBiquadFilter[] = [];
	public eqFilterCount: number = 0;
	public initialEqFilterInput1: number = 0;
	public initialEqFilterInput2: number = 0;

	public panningDelayLine: Float32Array | null = null;
	public panningDelayPos: number = 0;
	public panningVolumeL: number = 0;
	public panningVolumeR: number = 0;
	public panningVolumeDeltaL: number = 0;
	public panningVolumeDeltaR: number = 0;
	public panningOffsetL: number = 0;
	public panningOffsetR: number = 0;
	public panningOffsetDeltaL: number = 0;
	public panningOffsetDeltaR: number = 0;

	public chorusDelayLineL: Float32Array | null = null;
	public chorusDelayLineR: Float32Array | null = null;
	public chorusDelayLineDirty: boolean = false;
	public chorusDelayPos: number = 0;
	public chorusPhase: number = 0;
	public chorusVoiceMult: number = 0;
	public chorusVoiceMultDelta: number = 0;
	public chorusCombinedMult: number = 0;
	public chorusCombinedMultDelta: number = 0;

	public echoDelayLineL: Float32Array | null = null;
	public echoDelayLineR: Float32Array | null = null;
	public echoDelayLineDirty: boolean = false;
	public echoDelayPos: number = 0;
	public echoDelayOffsetStart: number = 0;
	public echoDelayOffsetEnd: number | null = null;
	public echoDelayOffsetRatio: number = 0;
	public echoDelayOffsetRatioDelta: number = 0;
	public echoMult: number = 0;
	public echoMultDelta: number = 0;
	public echoShelfA1: number = 0;
	public echoShelfB0: number = 0;
	public echoShelfB1: number = 0;
	public echoShelfSampleL: number = 0;
	public echoShelfSampleR: number = 0;
	public echoShelfPrevInputL: number = 0;
	public echoShelfPrevInputR: number = 0;

	public reverbDelayLine: Float32Array | null = null;
	public reverbDelayLineDirty: boolean = false;
	public reverbDelayPos: number = 0;
	public reverbMult: number = 0;
	public reverbMultDelta: number = 0;
	public reverbShelfA1: number = 0;
	public reverbShelfB0: number = 0;
	public reverbShelfB1: number = 0;
	public reverbShelfSample0: number = 0;
	public reverbShelfSample1: number = 0;
	public reverbShelfSample2: number = 0;
	public reverbShelfSample3: number = 0;
	public reverbShelfPrevInput0: number = 0;
	public reverbShelfPrevInput1: number = 0;
	public reverbShelfPrevInput2: number = 0;
	public reverbShelfPrevInput3: number = 0;

	//public readonly envelopeComputer: EnvelopeComputer = new EnvelopeComputer(false);
	public readonly spectrumWave: SpectrumWaveState = new SpectrumWaveState();
	public readonly harmonicsWave: HarmonicsWaveState = new HarmonicsWaveState();
	public readonly drumsetSpectrumWaves: SpectrumWaveState[] = [];

	constructor()
	{
		for (let i: number = 0; i < Config.drumCount; i++)
		{
			this.drumsetSpectrumWaves[i] = new SpectrumWaveState();
		}
	}


	public allocateNecessaryBuffers(synth: Synth, instrument: Instrument, samplesPerTick: number): void
	{
		if (effectsIncludePanning(instrument.effects))
		{
			if (this.panningDelayLine == null || this.panningDelayLine.length < synth.panningDelayBufferSize)
			{
				this.panningDelayLine = new Float32Array(synth.panningDelayBufferSize);
			}
		}
		if (effectsIncludeChorus(instrument.effects))
		{
			if (this.chorusDelayLineL == null || this.chorusDelayLineL.length < synth.chorusDelayBufferSize)
			{
				this.chorusDelayLineL = new Float32Array(synth.chorusDelayBufferSize);
			}
			if (this.chorusDelayLineR == null || this.chorusDelayLineR.length < synth.chorusDelayBufferSize)
			{
				this.chorusDelayLineR = new Float32Array(synth.chorusDelayBufferSize);
			}
		}
		if (effectsIncludeEcho(instrument.effects))
		{
			// account for tempo and delay automation changing delay length during a tick?
			const safeEchoDelaySteps: number = Math.max(Config.echoDelayRange >> 1, (instrument.echoDelay + 1)); // The delay may be very short now, but if it increases later make sure we have enough sample history.
			const baseEchoDelayBufferSize: number = Synth.fittingPowerOfTwo(safeEchoDelaySteps * Config.echoDelayStepTicks * samplesPerTick);
			const safeEchoDelayBufferSize: number = baseEchoDelayBufferSize * 2; // If the tempo or delay changes and we suddenly need a longer delay, make sure that we have enough sample history to accomodate the longer delay.

			if (this.echoDelayLineL == null || this.echoDelayLineR == null)
			{
				this.echoDelayLineL = new Float32Array(safeEchoDelayBufferSize);
				this.echoDelayLineR = new Float32Array(safeEchoDelayBufferSize);
			} else if (this.echoDelayLineL.length < safeEchoDelayBufferSize || this.echoDelayLineR.length < safeEchoDelayBufferSize)
			{
				// The echo delay length may change whlie the song is playing if tempo changes,
				// so buffers may need to be reallocated, but we don't want to lose any echoes
				// so we need to copy the contents of the old buffer to the new one.
				const newDelayLineL: Float32Array = new Float32Array(safeEchoDelayBufferSize);
				const newDelayLineR: Float32Array = new Float32Array(safeEchoDelayBufferSize);
				const oldMask: number = this.echoDelayLineL.length - 1;

				for (let i = 0; i < this.echoDelayLineL.length; i++)
				{
					newDelayLineL[i] = this.echoDelayLineL[(this.echoDelayPos + i) & oldMask];
					newDelayLineR[i] = this.echoDelayLineL[(this.echoDelayPos + i) & oldMask];
				}

				this.echoDelayPos = this.echoDelayLineL.length;
				this.echoDelayLineL = newDelayLineL;
				this.echoDelayLineR = newDelayLineR;
			}
		}
		if (effectsIncludeReverb(instrument.effects))
		{
			// TODO: Make reverb delay line sample rate agnostic. Maybe just double buffer size for 96KHz? Adjust attenuation and shelf cutoff appropriately?
			if (this.reverbDelayLine == null)
			{
				this.reverbDelayLine = new Float32Array(Config.reverbDelayBufferSize);
			}
		}
	}

	public deactivate(): void
	{
		this.bitcrusherPrevInput = 0;
		this.bitcrusherCurrentOutput = 0;
		this.bitcrusherPhase = 1;
		for (let i: number = 0; i < this.eqFilterCount; i++)
		{
			this.eqFilters[i].resetOutput();
		}
		this.eqFilterCount = 0;
		this.initialEqFilterInput1 = 0;
		this.initialEqFilterInput2 = 0;
		this.distortionFractionalInput1 = 0;
		this.distortionFractionalInput2 = 0;
		this.distortionFractionalInput3 = 0;
		this.distortionPrevInput = 0;
		this.distortionNextOutput = 0;
		this.panningDelayPos = 0;
		if (this.panningDelayLine != null) for (let i: number = 0; i < this.panningDelayLine.length; i++) this.panningDelayLine[i] = 0;
		this.echoDelayOffsetEnd = null;
		this.echoShelfSampleL = 0;
		this.echoShelfSampleR = 0;
		this.echoShelfPrevInputL = 0;
		this.echoShelfPrevInputR = 0;
		this.reverbShelfSample0 = 0;
		this.reverbShelfSample1 = 0;
		this.reverbShelfSample2 = 0;
		this.reverbShelfSample3 = 0;
		this.reverbShelfPrevInput0 = 0;
		this.reverbShelfPrevInput1 = 0;
		this.reverbShelfPrevInput2 = 0;
		this.reverbShelfPrevInput3 = 0;

		this.volumeScale = 1;
		this.aliases = false;

		this.awake = false;
		this.flushingDelayLines = false;
		this.deactivateAfterThisTick = false;
		this.attentuationProgress = 0;
		this.flushedSamples = 0;
	}

	public resetAllEffects(): void
	{
		this.deactivate();

		if (this.chorusDelayLineDirty)
		{
			for (let i: number = 0; i < this.chorusDelayLineL!.length; i++) this.chorusDelayLineL![i] = 0;
			for (let i: number = 0; i < this.chorusDelayLineR!.length; i++) this.chorusDelayLineR![i] = 0;
		}
		if (this.echoDelayLineDirty)
		{
			for (let i: number = 0; i < this.echoDelayLineL!.length; i++) this.echoDelayLineL![i] = 0;
			for (let i: number = 0; i < this.echoDelayLineR!.length; i++) this.echoDelayLineR![i] = 0;
		}
		if (this.reverbDelayLineDirty)
		{
			for (let i: number = 0; i < this.reverbDelayLine!.length; i++) this.reverbDelayLine![i] = 0;
		}

		this.chorusPhase = 0;
	}

	public compute(synth: Synth, instrument: Instrument, samplesPerTick: number, roundedSamplesPerTick: number, tone: Tone | null, channelIndex: number, instrumentIndex: number): void
	{
		this.computed = true;

		this.type = instrument.type;
		this.synthesizer = Synth.getInstrumentSynthFunction(instrument);
		this.unison = Config.unisons[instrument.unison];
		this.chord = instrument.getChord();
		this.noisePitchFilterMult = Config.chipNoises[instrument.chipNoise].pitchFilterMult;
		this.effects = instrument.effects;

		this.aliases = instrument.aliases;
		this.volumeScale = 1;

		this.allocateNecessaryBuffers(synth, instrument, samplesPerTick);

		const samplesPerSecond: number = synth.samplesPerSecond;
		this.updateWaves(instrument, samplesPerSecond);

		//const ticksIntoBar: number = synth.getTicksIntoBar();
		//const tickTimeStart: number = ticksIntoBar;
		//const tickTimeEnd:   number = ticksIntoBar + 1.0;
		//const secondsPerTick: number = samplesPerTick / synth.samplesPerSecond;
		//const currentPart: number = synth.getCurrentPart();
		//this.envelopeComputer.computeEnvelopes(instrument, currentPart, tickTimeStart, secondsPerTick, tone);
		//const envelopeStarts: number[] = this.envelopeComputer.envelopeStarts;
		//const envelopeEnds: number[] = this.envelopeComputer.envelopeEnds;
		const usesDistortion: boolean = effectsIncludeDistortion(this.effects);
		const usesBitcrusher: boolean = effectsIncludeBitcrusher(this.effects);
		const usesPanning: boolean = effectsIncludePanning(this.effects);
		const usesChorus: boolean = effectsIncludeChorus(this.effects);
		const usesEcho: boolean = effectsIncludeEcho(this.effects);
		const usesReverb: boolean = effectsIncludeReverb(this.effects);

		if (usesDistortion)
		{
			let useDistortionStart: number = instrument.distortion;
			let useDistortionEnd: number = instrument.distortion;

			// Check for distortion mods
			if (synth.isModActive(Config.modulators.dictionary["distortion"].index, channelIndex, instrumentIndex))
			{
				useDistortionStart = synth.getModValue(Config.modulators.dictionary["distortion"].index, channelIndex, instrumentIndex, false);
				useDistortionEnd = synth.getModValue(Config.modulators.dictionary["distortion"].index, channelIndex, instrumentIndex, true);
			}

			const distortionSliderStart = Math.min(1, /*envelopeStarts[InstrumentAutomationIndex.distortion] **/ useDistortionStart / (Config.distortionRange - 1));
			const distortionSliderEnd = Math.min(1, /*envelopeEnds[  InstrumentAutomationIndex.distortion] **/ useDistortionEnd / (Config.distortionRange - 1));
			const distortionStart: number = Math.pow(1 - 0.895 * (Math.pow(20, distortionSliderStart) - 1) / 19, 2);
			const distortionEnd: number = Math.pow(1 - 0.895 * (Math.pow(20, distortionSliderEnd) - 1) / 19, 2);
			const distortionDriveStart: number = (1 + 2 * distortionSliderStart) / Config.distortionBaseVolume;
			const distortionDriveEnd: number = (1 + 2 * distortionSliderEnd) / Config.distortionBaseVolume;
			this.distortion = distortionStart;
			this.distortionDelta = (distortionEnd - distortionStart) / roundedSamplesPerTick;
			this.distortionDrive = distortionDriveStart;
			this.distortionDriveDelta = (distortionDriveEnd - distortionDriveStart) / roundedSamplesPerTick;
		}

		if (usesBitcrusher)
		{
			let freqSettingStart: number = instrument.bitcrusherFreq /** Math.sqrt(envelopeStarts[InstrumentAutomationIndex.bitcrusherFrequency])*/;
			let freqSettingEnd: number = instrument.bitcrusherFreq /** Math.sqrt(envelopeEnds[  InstrumentAutomationIndex.bitcrusherFrequency])*/;

			// Check for freq crush mods
			if (synth.isModActive(Config.modulators.dictionary["freq crush"].index, channelIndex, instrumentIndex))
			{
				freqSettingStart = synth.getModValue(Config.modulators.dictionary["freq crush"].index, channelIndex, instrumentIndex, false);
				freqSettingEnd = synth.getModValue(Config.modulators.dictionary["freq crush"].index, channelIndex, instrumentIndex, true);
			}

			let quantizationSettingStart: number = instrument.bitcrusherQuantization /** Math.sqrt(envelopeStarts[InstrumentAutomationIndex.bitcrusherQuantization])*/;
			let quantizationSettingEnd: number = instrument.bitcrusherQuantization /** Math.sqrt(envelopeEnds[  InstrumentAutomationIndex.bitcrusherQuantization])*/;

			// Check for bitcrush mods
			if (synth.isModActive(Config.modulators.dictionary["bit crush"].index, channelIndex, instrumentIndex))
			{
				quantizationSettingStart = synth.getModValue(Config.modulators.dictionary["bit crush"].index, channelIndex, instrumentIndex, false);
				quantizationSettingEnd = synth.getModValue(Config.modulators.dictionary["bit crush"].index, channelIndex, instrumentIndex, true);
			}

			const basePitch: number = Config.keys[synth.song!.key].basePitch; // TODO: What if there's a key change mid-song?
			const freqStart: number = Instrument.frequencyFromPitch(basePitch + 60) * Math.pow(2, (Config.bitcrusherFreqRange - 1 - freqSettingStart) * Config.bitcrusherOctaveStep);
			const freqEnd: number = Instrument.frequencyFromPitch(basePitch + 60) * Math.pow(2, (Config.bitcrusherFreqRange - 1 - freqSettingEnd) * Config.bitcrusherOctaveStep);
			const phaseDeltaStart: number = Math.min(1, freqStart / samplesPerSecond);
			const phaseDeltaEnd: number = Math.min(1, freqEnd / samplesPerSecond);
			this.bitcrusherPhaseDelta = phaseDeltaStart;
			this.bitcrusherPhaseDeltaScale = Math.pow(phaseDeltaEnd / phaseDeltaStart, 1 / roundedSamplesPerTick);

			const scaleStart: number = 2 * Config.bitcrusherBaseVolume * Math.pow(2, 1 - Math.pow(2, (Config.bitcrusherQuantizationRange - 1 - quantizationSettingStart) * 0.5));
			const scaleEnd: number = 2 * Config.bitcrusherBaseVolume * Math.pow(2, 1 - Math.pow(2, (Config.bitcrusherQuantizationRange - 1 - quantizationSettingEnd) * 0.5));
			this.bitcrusherScale = scaleStart;
			this.bitcrusherScaleScale = Math.pow(scaleEnd / scaleStart, 1 / roundedSamplesPerTick);

			const foldLevelStart: number = 2 * Config.bitcrusherBaseVolume * Math.pow(1.5, Config.bitcrusherQuantizationRange - 1 - quantizationSettingStart);
			const foldLevelEnd: number = 2 * Config.bitcrusherBaseVolume * Math.pow(1.5, Config.bitcrusherQuantizationRange - 1 - quantizationSettingEnd);
			this.bitcrusherFoldLevel = foldLevelStart;
			this.bitcrusherFoldLevelScale = Math.pow(foldLevelEnd / foldLevelStart, 1 / roundedSamplesPerTick);
		}

		let eqFilterVolume: number = 1; //this.envelopeComputer.lowpassCutoffDecayVolumeCompensation;
		if (instrument.eqFilterType)
		{
			// Simple EQ filter (old style). For analysis, using random filters from normal style since they are N/A in this context.
			const eqFilterSettingsStart: FilterSettings = instrument.eqFilter;
			if (instrument.eqSubFilters[1] == null)
				instrument.eqSubFilters[1] = new FilterSettings();
			const eqFilterSettingsEnd: FilterSettings = instrument.eqSubFilters[1];

			// Change location based on slider values
			let startSimpleFreq: number = instrument.eqFilterSimpleCut;
			let startSimpleGain: number = instrument.eqFilterSimplePeak;
			let endSimpleFreq: number = instrument.eqFilterSimpleCut;
			let endSimpleGain: number = instrument.eqFilterSimplePeak;

			let filterChanges: boolean = false;

			if (synth.isModActive(Config.modulators.dictionary["eq filt cut"].index, channelIndex, instrumentIndex))
			{
				startSimpleFreq = synth.getModValue(Config.modulators.dictionary["eq filt cut"].index, channelIndex, instrumentIndex, false);
				endSimpleFreq = synth.getModValue(Config.modulators.dictionary["eq filt cut"].index, channelIndex, instrumentIndex, true);
				filterChanges = true;
			}
			if (synth.isModActive(Config.modulators.dictionary["eq filt peak"].index, channelIndex, instrumentIndex))
			{
				startSimpleGain = synth.getModValue(Config.modulators.dictionary["eq filt peak"].index, channelIndex, instrumentIndex, false);
				endSimpleGain = synth.getModValue(Config.modulators.dictionary["eq filt peak"].index, channelIndex, instrumentIndex, true);
				filterChanges = true;
			}

			let startPoint: FilterControlPoint;

			if (filterChanges)
			{
				eqFilterSettingsStart.convertLegacySettingsForSynth(startSimpleFreq, startSimpleGain);
				eqFilterSettingsEnd.convertLegacySettingsForSynth(endSimpleFreq, endSimpleGain);

				startPoint = eqFilterSettingsStart.controlPoints[0];
				let endPoint: FilterControlPoint = eqFilterSettingsEnd.controlPoints[0];

				startPoint.toCoefficients(Synth.tempFilterStartCoefficients, samplesPerSecond, 1, 1);
				endPoint.toCoefficients(Synth.tempFilterEndCoefficients, samplesPerSecond, 1, 1);

				if (this.eqFilters.length < 1) this.eqFilters[0] = new DynamicBiquadFilter();
				this.eqFilters[0].loadCoefficientsWithGradient(Synth.tempFilterStartCoefficients, Synth.tempFilterEndCoefficients, 1 / roundedSamplesPerTick, startPoint.type == FilterType.lowPass);

			} else
			{
				eqFilterSettingsStart.convertLegacySettingsForSynth(startSimpleFreq, startSimpleGain, true);

				startPoint = eqFilterSettingsStart.controlPoints[0];

				startPoint.toCoefficients(Synth.tempFilterStartCoefficients, samplesPerSecond, 1, 1);

				if (this.eqFilters.length < 1) this.eqFilters[0] = new DynamicBiquadFilter();
				this.eqFilters[0].loadCoefficientsWithGradient(Synth.tempFilterStartCoefficients, Synth.tempFilterStartCoefficients, 1 / roundedSamplesPerTick, startPoint.type == FilterType.lowPass);

			}

			eqFilterVolume *= startPoint.getVolumeCompensationMult();

			this.eqFilterCount = 1;
			eqFilterVolume = Math.min(3, eqFilterVolume);
		}
		else
		{
			const eqFilterSettings: FilterSettings = (instrument.tmpEqFilterStart != null) ? instrument.tmpEqFilterStart : instrument.eqFilter;
			//const eqAllFreqsEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.eqFilterAllFreqs];
			//const eqAllFreqsEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.eqFilterAllFreqs];
			for (let i: number = 0; i < eqFilterSettings.controlPointCount; i++)
			{
				//const eqFreqEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.eqFilterFreq0 + i];
				//const eqFreqEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.eqFilterFreq0 + i];
				//const eqPeakEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.eqFilterGain0 + i];
				//const eqPeakEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.eqFilterGain0 + i];
				let startPoint: FilterControlPoint = eqFilterSettings.controlPoints[i];
				let endPoint: FilterControlPoint = (instrument.tmpEqFilterEnd != null && instrument.tmpEqFilterEnd.controlPoints[i] != null) ? instrument.tmpEqFilterEnd.controlPoints[i] : eqFilterSettings.controlPoints[i];

				// If switching dot type, do it all at once and do not try to interpolate since no valid interpolation exists.
				if (startPoint.type != endPoint.type)
				{
					startPoint = endPoint;
				}

				startPoint.toCoefficients(Synth.tempFilterStartCoefficients, samplesPerSecond, /*eqAllFreqsEnvelopeStart * eqFreqEnvelopeStart*/ 1, /*eqPeakEnvelopeStart*/ 1);
				endPoint.toCoefficients(Synth.tempFilterEndCoefficients, samplesPerSecond, /*eqAllFreqsEnvelopeEnd   * eqFreqEnvelopeEnd*/ 1, /*eqPeakEnvelopeEnd*/ 1);
				if (this.eqFilters.length <= i) this.eqFilters[i] = new DynamicBiquadFilter();
				this.eqFilters[i].loadCoefficientsWithGradient(Synth.tempFilterStartCoefficients, Synth.tempFilterEndCoefficients, 1 / roundedSamplesPerTick, startPoint.type == FilterType.lowPass);
				eqFilterVolume *= startPoint.getVolumeCompensationMult();

			}
			this.eqFilterCount = eqFilterSettings.controlPointCount;
			eqFilterVolume = Math.min(3, eqFilterVolume);
		}

		const mainInstrumentVolume: number = Synth.instrumentVolumeToVolumeMult(instrument.volume);
		this.mixVolume = mainInstrumentVolume /** envelopeStarts[InstrumentAutomationIndex.mixVolume]*/;
		let mixVolumeEnd: number = mainInstrumentVolume /** envelopeEnds[  InstrumentAutomationIndex.mixVolume]*/;

		// Check for mod-related volume delta
		if (synth.isModActive(Config.modulators.dictionary["mix volume"].index, channelIndex, instrumentIndex))
		{
			// Linear falloff below 0, normal volume formula above 0. Seems to work best for scaling since the normal volume mult formula has a big gap from -25 to -24.
			const startVal: number = synth.getModValue(Config.modulators.dictionary["mix volume"].index, channelIndex, instrumentIndex, false);
			const endVal: number = synth.getModValue(Config.modulators.dictionary["mix volume"].index, channelIndex, instrumentIndex, true);
			this.mixVolume *= ((startVal <= 0) ? ((startVal + Config.volumeRange / 2) / (Config.volumeRange / 2)) : Synth.instrumentVolumeToVolumeMult(startVal));
			mixVolumeEnd *= ((endVal <= 0) ? ((endVal + Config.volumeRange / 2) / (Config.volumeRange / 2)) : Synth.instrumentVolumeToVolumeMult(endVal));
		}

		// Check for SONG mod-related volume delta
		if (synth.isModActive(Config.modulators.dictionary["song volume"].index))
		{
			this.mixVolume *= (synth.getModValue(Config.modulators.dictionary["song volume"].index, undefined, undefined, false)) / 100;
			mixVolumeEnd *= (synth.getModValue(Config.modulators.dictionary["song volume"].index, undefined, undefined, true)) / 100;
		}

		this.mixVolumeDelta = (mixVolumeEnd - this.mixVolume) / roundedSamplesPerTick;

		let eqFilterVolumeStart: number = eqFilterVolume;
		let eqFilterVolumeEnd: number = eqFilterVolume;
		let delayInputMultStart: number = 1;
		let delayInputMultEnd: number = 1;

		if (usesPanning)
		{
			//const panEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.panning] * 2.0 - 1.0;
			//const panEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.panning] * 2.0 - 1.0;
			let usePanStart: number = instrument.pan;
			let usePanEnd: number = instrument.pan;
			// Check for pan mods
			if (synth.isModActive(Config.modulators.dictionary["pan"].index, channelIndex, instrumentIndex))
			{
				usePanStart = synth.getModValue(Config.modulators.dictionary["pan"].index, channelIndex, instrumentIndex, false);
				usePanEnd = synth.getModValue(Config.modulators.dictionary["pan"].index, channelIndex, instrumentIndex, true);
			}

			let panStart: number = Math.max(-1, Math.min(1, (usePanStart - Config.panCenter) / Config.panCenter /** panEnvelopeStart*/));
			let panEnd: number = Math.max(-1, Math.min(1, (usePanEnd - Config.panCenter) / Config.panCenter /** panEnvelopeEnd  */));

			const volumeStartL: number = Math.cos((1 + panStart) * Math.PI * 0.25) * 1.414;
			const volumeStartR: number = Math.cos((1 - panStart) * Math.PI * 0.25) * 1.414;
			const volumeEndL: number = Math.cos((1 + panEnd) * Math.PI * 0.25) * 1.414;
			const volumeEndR: number = Math.cos((1 - panEnd) * Math.PI * 0.25) * 1.414;
			const maxDelaySamples: number = samplesPerSecond * Config.panDelaySecondsMax;

			let usePanDelayStart: number = instrument.panDelay;
			let usePanDelayEnd: number = instrument.panDelay;
			// Check for pan delay mods
			if (synth.isModActive(Config.modulators.dictionary["pan delay"].index, channelIndex, instrumentIndex))
			{
				usePanDelayStart = synth.getModValue(Config.modulators.dictionary["pan delay"].index, channelIndex, instrumentIndex, false);
				usePanDelayEnd = synth.getModValue(Config.modulators.dictionary["pan delay"].index, channelIndex, instrumentIndex, true);
			}

			const delayStart: number = panStart * usePanDelayStart * maxDelaySamples / 10;
			const delayEnd: number = panEnd * usePanDelayEnd * maxDelaySamples / 10;
			const delayStartL: number = Math.max(0, delayStart);
			const delayStartR: number = Math.max(0, -delayStart);
			const delayEndL: number = Math.max(0, delayEnd);
			const delayEndR: number = Math.max(0, -delayEnd);

			this.panningVolumeL = volumeStartL;
			this.panningVolumeR = volumeStartR;
			this.panningVolumeDeltaL = (volumeEndL - volumeStartL) / roundedSamplesPerTick;
			this.panningVolumeDeltaR = (volumeEndR - volumeStartR) / roundedSamplesPerTick;
			this.panningOffsetL = this.panningDelayPos - delayStartL + synth.panningDelayBufferSize;
			this.panningOffsetR = this.panningDelayPos - delayStartR + synth.panningDelayBufferSize;
			this.panningOffsetDeltaL = (delayEndL - delayStartL) / roundedSamplesPerTick;
			this.panningOffsetDeltaR = (delayEndR - delayStartR) / roundedSamplesPerTick;
		}

		if (usesChorus)
		{
			//const chorusEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.chorus];
			//const chorusEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.chorus];
			let useChorusStart: number = instrument.chorus;
			let useChorusEnd: number = instrument.chorus;
			// Check for chorus mods
			if (synth.isModActive(Config.modulators.dictionary["chorus"].index, channelIndex, instrumentIndex))
			{
				useChorusStart = synth.getModValue(Config.modulators.dictionary["chorus"].index, channelIndex, instrumentIndex, false);
				useChorusEnd = synth.getModValue(Config.modulators.dictionary["chorus"].index, channelIndex, instrumentIndex, true);
			}

			let chorusStart: number = Math.min(1, /*chorusEnvelopeStart **/ useChorusStart / (Config.chorusRange - 1));
			let chorusEnd: number = Math.min(1, /*chorusEnvelopeEnd   **/ useChorusEnd / (Config.chorusRange - 1));
			chorusStart = chorusStart * 0.6 + (Math.pow(chorusStart, 6)) * 0.4;
			chorusEnd = chorusEnd * 0.6 + (Math.pow(chorusEnd, 6)) * 0.4;
			const chorusCombinedMultStart = 1 / Math.sqrt(3 * chorusStart * chorusStart + 1);
			const chorusCombinedMultEnd = 1 / Math.sqrt(3 * chorusEnd * chorusEnd + 1);
			this.chorusVoiceMult = chorusStart;
			this.chorusVoiceMultDelta = (chorusEnd - chorusStart) / roundedSamplesPerTick;
			this.chorusCombinedMult = chorusCombinedMultStart;
			this.chorusCombinedMultDelta = (chorusCombinedMultEnd - chorusCombinedMultStart) / roundedSamplesPerTick;
		}

		let maxEchoMult = 0;
		let averageEchoDelaySeconds: number = 0;
		if (usesEcho)
		{
			//const echoSustainEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.echoSustain];
			//const echoSustainEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.echoSustain];
			let useEchoSustainStart: number = instrument.echoSustain;
			let useEchoSustainEnd: number = instrument.echoSustain;
			// Check for echo mods
			if (synth.isModActive(Config.modulators.dictionary["echo"].index, channelIndex, instrumentIndex))
			{
				useEchoSustainStart = Math.max(0, synth.getModValue(Config.modulators.dictionary["echo"].index, channelIndex, instrumentIndex, false));
				useEchoSustainEnd = Math.max(0, synth.getModValue(Config.modulators.dictionary["echo"].index, channelIndex, instrumentIndex, true));
			}
			const echoMultStart: number = Math.min(1, Math.pow(/*echoSustainEnvelopeStart **/ useEchoSustainStart / Config.echoSustainRange, 1.1)) * 0.9;
			const echoMultEnd: number = Math.min(1, Math.pow(/*echoSustainEnvelopeEnd   **/ useEchoSustainEnd / Config.echoSustainRange, 1.1)) * 0.9;
			this.echoMult = echoMultStart;
			this.echoMultDelta = Math.max(0, (echoMultEnd - echoMultStart) / roundedSamplesPerTick);
			maxEchoMult = Math.max(echoMultStart, echoMultEnd);

			// TODO: After computing a tick's settings once for multiple run lengths (which is
			// good for audio worklet threads), compute the echo delay envelopes at tick (or
			// part) boundaries to interpolate between two delay taps.
			//const echoDelayEnvelopeStart:   number = envelopeStarts[InstrumentAutomationIndex.echoDelay];
			//const echoDelayEnvelopeEnd:     number = envelopeEnds[  InstrumentAutomationIndex.echoDelay];
			let useEchoDelayStart: number = instrument.echoDelay;
			let useEchoDelayEnd: number = instrument.echoDelay;
			let ignoreTicks: boolean = false;
			// Check for pan delay mods
			if (synth.isModActive(Config.modulators.dictionary["echo delay"].index, channelIndex, instrumentIndex))
			{
				useEchoDelayStart = synth.getModValue(Config.modulators.dictionary["echo delay"].index, channelIndex, instrumentIndex, false);
				useEchoDelayEnd = synth.getModValue(Config.modulators.dictionary["echo delay"].index, channelIndex, instrumentIndex, true);
				ignoreTicks = true;
			}

			const tmpEchoDelayOffsetStart: number = Math.round((useEchoDelayStart + 1) * Config.echoDelayStepTicks * samplesPerTick);
			const tmpEchoDelayOffsetEnd: number = Math.round((useEchoDelayEnd + 1) * Config.echoDelayStepTicks * samplesPerTick);
			if (this.echoDelayOffsetEnd != null && !ignoreTicks)
			{
				this.echoDelayOffsetStart = this.echoDelayOffsetEnd;
			} else
			{
				this.echoDelayOffsetStart = tmpEchoDelayOffsetStart;
			}

			this.echoDelayOffsetEnd = tmpEchoDelayOffsetEnd;
			averageEchoDelaySeconds = (this.echoDelayOffsetStart + this.echoDelayOffsetEnd) * 0.5 / samplesPerSecond;

			this.echoDelayOffsetRatio = 0;
			this.echoDelayOffsetRatioDelta = 1 / roundedSamplesPerTick;

			const shelfRadians: number = 2 * Math.PI * Config.echoShelfHz / synth.samplesPerSecond;
			Synth.tempFilterStartCoefficients.highShelf1stOrder(shelfRadians, Config.echoShelfGain);
			this.echoShelfA1 = Synth.tempFilterStartCoefficients.a[1];
			this.echoShelfB0 = Synth.tempFilterStartCoefficients.b[0];
			this.echoShelfB1 = Synth.tempFilterStartCoefficients.b[1];
		}

		let maxReverbMult = 0;
		if (usesReverb)
		{
			//const reverbEnvelopeStart: number = envelopeStarts[InstrumentAutomationIndex.reverb];
			//const reverbEnvelopeEnd:   number = envelopeEnds[  InstrumentAutomationIndex.reverb];
			let useReverbStart: number = instrument.reverb;
			let useReverbEnd: number = instrument.reverb;

			// Check for mod reverb, instrument level
			if (synth.isModActive(Config.modulators.dictionary["reverb"].index, channelIndex, instrumentIndex))
			{
				useReverbStart = synth.getModValue(Config.modulators.dictionary["reverb"].index, channelIndex, instrumentIndex, false);
				useReverbEnd = synth.getModValue(Config.modulators.dictionary["reverb"].index, channelIndex, instrumentIndex, true);
			}
			// Check for mod reverb, song scalar
			if (synth.isModActive(Config.modulators.dictionary["song reverb"].index, channelIndex, instrumentIndex))
			{
				useReverbStart *= (synth.getModValue(Config.modulators.dictionary["song reverb"].index, undefined, undefined, false) - Config.modulators.dictionary["song reverb"].convertRealFactor) / Config.reverbRange;
				useReverbEnd *= (synth.getModValue(Config.modulators.dictionary["song reverb"].index, undefined, undefined, true) - Config.modulators.dictionary["song reverb"].convertRealFactor) / Config.reverbRange;
			}

			const reverbStart: number = Math.min(1, Math.pow(/*reverbEnvelopeStart **/ useReverbStart / Config.reverbRange, 0.667)) * 0.425;
			const reverbEnd: number = Math.min(1, Math.pow(/*reverbEnvelopeEnd   **/ useReverbEnd / Config.reverbRange, 0.667)) * 0.425;

			this.reverbMult = reverbStart;
			this.reverbMultDelta = (reverbEnd - reverbStart) / roundedSamplesPerTick;
			maxReverbMult = Math.max(reverbStart, reverbEnd);

			const shelfRadians: number = 2 * Math.PI * Config.reverbShelfHz / synth.samplesPerSecond;
			Synth.tempFilterStartCoefficients.highShelf1stOrder(shelfRadians, Config.reverbShelfGain);
			this.reverbShelfA1 = Synth.tempFilterStartCoefficients.a[1];
			this.reverbShelfB0 = Synth.tempFilterStartCoefficients.b[0];
			this.reverbShelfB1 = Synth.tempFilterStartCoefficients.b[1];
		}

		if (this.tonesAddedInThisTick)
		{
			this.attentuationProgress = 0;
			this.flushedSamples = 0;
			this.flushingDelayLines = false;
		} else if (!this.flushingDelayLines)
		{
			// If this instrument isn't playing tones anymore, the volume can fade out by the
			// end of the first tick. It's possible for filters and the panning delay line to
			// continue past the end of the tone but they should have mostly dissipated by the
			// end of the tick anyway.
			if (this.attentuationProgress == 0)
			{
				eqFilterVolumeEnd = 0;
			} else
			{
				eqFilterVolumeStart = 0;
				eqFilterVolumeEnd = 0;
			}

			const attenuationThreshold: number = 1 / 256; // when the delay line signal has attenuated this much, it should be inaudible and should be flushed to zero.
			const halfLifeMult: number = -Math.log2(attenuationThreshold);
			let delayDuration: number = 0;

			if (usesChorus)
			{
				delayDuration += Config.chorusMaxDelay;
			}

			if (usesEcho)
			{
				const attenuationPerSecond: number = Math.pow(maxEchoMult, 1 / averageEchoDelaySeconds);
				const halfLife: number = -1 / Math.log2(attenuationPerSecond);
				const echoDuration: number = halfLife * halfLifeMult;
				delayDuration += echoDuration;
			}

			if (usesReverb)
			{
				const averageMult: number = maxReverbMult * 2;
				const averageReverbDelaySeconds: number = (Config.reverbDelayBufferSize / 4) / samplesPerSecond;
				const attenuationPerSecond: number = Math.pow(averageMult, 1 / averageReverbDelaySeconds);
				const halfLife: number = -1 / Math.log2(attenuationPerSecond);
				const reverbDuration: number = halfLife * halfLifeMult;
				delayDuration += reverbDuration;
			}

			const secondsInTick: number = samplesPerTick / samplesPerSecond;
			const progressInTick: number = secondsInTick / delayDuration;
			const progressAtEndOfTick: number = this.attentuationProgress + progressInTick;
			if (progressAtEndOfTick >= 1)
			{
				delayInputMultEnd = 0;
			}

			this.attentuationProgress = progressAtEndOfTick;
			if (this.attentuationProgress >= 1)
			{
				this.flushingDelayLines = true;
			}
		} else
		{
			// Flushing delay lines to zero since the signal has mostly dissipated.
			eqFilterVolumeStart = 0;
			eqFilterVolumeEnd = 0;
			delayInputMultStart = 0;
			delayInputMultEnd = 0;

			let totalDelaySamples: number = 0;
			if (usesChorus) totalDelaySamples += synth.chorusDelayBufferSize;
			if (usesEcho) totalDelaySamples += this.echoDelayLineL!.length;
			if (usesReverb) totalDelaySamples += Config.reverbDelayBufferSize;

			this.flushedSamples += roundedSamplesPerTick;
			if (this.flushedSamples >= totalDelaySamples)
			{
				this.deactivateAfterThisTick = true;
			}
		}

		this.eqFilterVolume = eqFilterVolumeStart;
		this.eqFilterVolumeDelta = (eqFilterVolumeEnd - eqFilterVolumeStart) / roundedSamplesPerTick;
		this.delayInputMult = delayInputMultStart;
		this.delayInputMultDelta = (delayInputMultEnd - delayInputMultStart) / roundedSamplesPerTick;
	}

	public updateWaves(instrument: Instrument, samplesPerSecond: number): void
	{
		this.volumeScale = 1;
		if (instrument.type == InstrumentType.chip)
		{
			this.wave = (this.aliases) ? Config.rawChipWaves[instrument.chipWave].samples : Config.chipWaves[instrument.chipWave].samples;
		} else if (instrument.type == InstrumentType.customChipWave)
		{
			this.wave = (this.aliases) ? instrument.customChipWave! : instrument.customChipWaveIntegral!;
			this.volumeScale = 0.05;
		} else if (instrument.type == InstrumentType.noise)
		{
			this.wave = getDrumWave(instrument.chipNoise, inverseRealFourierTransform, scaleElementsByFactor);
		} else if (instrument.type == InstrumentType.harmonics)
		{
			this.wave = this.harmonicsWave.getCustomWave(instrument.harmonicsWave, instrument.type);
		} else if (instrument.type == InstrumentType.pickedString)
		{
			this.wave = this.harmonicsWave.getCustomWave(instrument.harmonicsWave, instrument.type);
		} else if (instrument.type == InstrumentType.spectrum)
		{
			this.wave = this.spectrumWave.getCustomWave(instrument.spectrumWave, 8);
		} else if (instrument.type == InstrumentType.drumset)
		{
			for (let i: number = 0; i < Config.drumCount; i++)
			{
				this.drumsetSpectrumWaves[i].getCustomWave(instrument.drumsetSpectrumWaves[i], InstrumentState._drumsetIndexToSpectrumOctave(i));
			}
			this.wave = null;
		} else
		{
			this.wave = null;
		}
	}

	public getDrumsetWave(pitch: number): Float32Array
	{
		if (this.type == InstrumentType.drumset)
		{
			return this.drumsetSpectrumWaves[pitch].wave!;
		} else
		{
			throw new Error("Unhandled instrument type in getDrumsetWave");
		}
	}

	public static drumsetIndexReferenceDelta(index: number): number
	{
		return Instrument.frequencyFromPitch(Config.spectrumBasePitch + index * 6) / 44100;
	}

	private static _drumsetIndexToSpectrumOctave(index: number): number
	{
		return 15 + Math.log2(InstrumentState.drumsetIndexReferenceDelta(index));
	}
}

