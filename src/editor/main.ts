/** @format */

// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import {
	Dictionary,
	DictionaryArray,
	EnvelopeType,
	InstrumentType,
	Transition,
	Chord,
	Envelope,
	Config
} from "../synth/SynthConfig";
import { isMobile, EditorConfig } from "./EditorConfig";
import { ColorConfig } from "./ColorConfig";
import "./style"; // Import for the side effects, there's no exports.
import { SongEditor } from "./SongEditor";
import { Channel, Synth } from "../synth/synth";
import { Song } from "../synth/Song";
import { Instrument } from "../synth/Instrument";
import { Pattern } from "../synth/Pattern";
import { NotePin } from "../synth/Note";
import { Note } from "../synth/Note";
import { SongDocument } from "./SongDocument";
import { ExportPrompt } from "./ExportPrompt";
import { ChangePreset } from "./changes";
import { Doc } from "./GlobalDoc";
import $ from "jquery";
import { Select2 } from "select2";

(window as any)["beepbox"] = {
	Config,
	Synth
};

$.fn.select2 = (window as any)["$"].fn.select2;

const editor: SongEditor = new SongEditor();
const beepboxEditorContainer: HTMLElement = document.getElementById("beepboxEditorContainer")!;
beepboxEditorContainer.appendChild(editor.mainLayer);
editor.whenUpdated();

// Fade-in transitions
editor.mainLayer.className += " load";
editor.mainLayer.getElementsByClassName("pattern-area")[0].className += " load";
editor.mainLayer.getElementsByClassName("settings-area")[0].className += " load";
editor.mainLayer.getElementsByClassName("editor-song-settings")[0].className += " load";
editor.mainLayer.getElementsByClassName("instrument-settings-area")[0].className += " load";
editor.mainLayer.getElementsByClassName("trackAndMuteContainer")[0].className += " load";
editor.mainLayer.getElementsByClassName("barScrollBar")[0].className += " load";

// Give select2 class to these
$("#pitchPresetSelect").select2({ dropdownAutoWidth: true });
$("#drumPresetSelect").select2({ dropdownAutoWidth: true });

// Onclick event to expand/collapse optgroups
$("body").on("click", ".select2-container--open .select2-results__group", function () {
	$(this).siblings().toggle();
});

// Open event to collapse all optgroups by default
$("#pitchPresetSelect").on("select2:open", function () {
	$(".select2-dropdown--below").css("opacity", 0);
	$(".select2-dropdown").css("opacity", 1);
	$("#pitchPresetSelect");
	setTimeout(() => {
		let groups = $(".select2-container--open .select2-results__group");
		let options = $(".select2-container--open .select2-results__option");

		$.each(groups, (index, v) => {
			$(v).siblings().hide();
			$(v)[0].setAttribute(
				"style",
				"color: " + ColorConfig.getChannelColor(Doc.song, Doc.channel).primaryNote + ";"
			);
		});
		$.each(options, (index, v) => {
			$(v)[0].setAttribute(
				"style",
				"color: " + ColorConfig.getChannelColor(Doc.song, Doc.channel).primaryNote + ";"
			);
		});

		$(".select2-dropdown--below").css("opacity", 1);
	}, 0);
});

// Open event to collapse all optgroups by default
$("#drumPresetSelect").on("select2:open", function () {
	$(".select2-dropdown--below").css("opacity", 0);
	$(".select2-dropdown").css("opacity", 1);
	$("#drumPresetSelect");
	setTimeout(() => {
		let groups = $(".select2-container--open .select2-results__group");
		let options = $(".select2-container--open .select2-results__option");

		$.each(groups, (index, v) => {
			$(v).siblings().hide();
			$(v)[0].setAttribute(
				"style",
				"color: " + ColorConfig.getChannelColor(Doc.song, Doc.channel).primaryNote + ";"
			);
		});
		$.each(options, (index, v) => {
			$(v)[0].setAttribute(
				"style",
				"color: " + ColorConfig.getChannelColor(Doc.song, Doc.channel).primaryNote + ";"
			);
		});

		$(".select2-dropdown--below").css("opacity", 1);
	}, 0);
});

// Select2 events
// The latter is to ensure select2 doesn't keep focus after the select2 is closed without making a selection.
$("#pitchPresetSelect").on("change", editor._whenSetPitchedPreset);
$("#pitchPresetSelect").on("select2:close", editor._refocus);

$("#drumPresetSelect").on("change", editor._whenSetDrumPreset);
$("#drumPresetSelect").on("select2:close", editor._refocus);

editor.mainLayer.focus();

// don't autoplay on mobile devices, wait for input.
if (!isMobile && Doc.prefs.autoPlay) {
	function autoplay(): void {
		if (!document.hidden) {
			Doc.synth.play();
			editor.updatePlayButton();
			window.removeEventListener("visibilitychange", autoplay);
		}
	}
	if (document.hidden) {
		// Wait until the tab is visible to autoplay:
		window.addEventListener("visibilitychange", autoplay);
	} else {
		// Can't call this immediately, as main.ts needs to finish executing for the beepbox namespace to finish being declared.
		window.setTimeout(autoplay);
	}
}

// BeepBox uses browser history state as its own undo history. Browsers typically
// remember scroll position for each history state, but BeepBox users would prefer not
// auto scrolling when undoing. Sadly this tweak doesn't work on Edge or IE.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

editor.updatePlayButton();

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/service_worker.js", { updateViaCache: "all", scope: "/" }).catch(() => {});
}

// When compiling synth.ts as a standalone module named "beepbox", expose these classes as members to JavaScript:
export {
	type Dictionary,
	type DictionaryArray,
	EnvelopeType,
	InstrumentType,
	type Transition,
	type Chord,
	type Envelope,
	Config,
	type NotePin,
	Note,
	Pattern,
	Instrument,
	Channel,
	Song,
	Synth,
	ColorConfig,
	EditorConfig,
	SongDocument,
	SongEditor,
	ExportPrompt,
	ChangePreset
};
