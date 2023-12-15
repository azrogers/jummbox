import{H as ee,C as o,f as te,S as g,a as d}from"./synth-EfHF9c40.js";const{a:P,button:D,div:k,h1:Le,input:Ce}=ee,{svg:V,circle:Be,rect:K,path:W}=g;document.head.appendChild(ee.style({type:"text/css"},`
	body {
		color: ${o.primaryText};
		background: ${o.editorBackground};
	}
	h1 {
		font-weight: bold;
		font-size: 14px;
		line-height: 22px;
		text-align: initial;
		margin: 0;
	}
	a {
		font-weight: bold;
		font-size: 12px;
		line-height: 22px;
		white-space: nowrap;
		color: ${o.linkAccent};
	}
	button {
		margin: 0;
		padding: 0;
		position: relative;
		border: none;
		border-radius: 5px;
		background: ${o.uiWidgetBackground};
		color: ${o.primaryText};
		cursor: pointer;
		font-size: 14px;
		font-family: inherit;
	}
	button:hover, button:focus {
		background: ${o.uiWidgetFocus};
	}
	.playButton, .pauseButton {
		padding-left: 24px;
		padding-right: 6px;
	}
	.playButton::before {
		content: "";
		position: absolute;
		left: 6px;
		top: 50%;
		margin-top: -6px;
		width: 12px;
		height: 12px;
		pointer-events: none;
		background: ${o.primaryText};
		-webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="-6 -6 12 12"><path d="M 6 0 L -5 6 L -5 -6 z" fill="gray"/></svg>');
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="-6 -6 12 12"><path d="M 6 0 L -5 6 L -5 -6 z" fill="gray"/></svg>');
		mask-repeat: no-repeat;
		mask-position: center;
	}
	.pauseButton::before {
		content: "";
		position: absolute;
		left: 6px;
		top: 50%;
		margin-top: -6px;
		width: 12px;
		height: 12px;
		pointer-events: none;
		background: ${o.primaryText};
		-webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="-6 -6 12 12"><rect x="-5" y="-6" width="3" height="12" fill="gray"/><rect x="2"  y="-6" width="3" height="12" fill="gray"/></svg>');
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="-6 -6 12 12"><rect x="-5" y="-6" width="3" height="12" fill="gray"/><rect x="2"  y="-6" width="3" height="12" fill="gray"/></svg>');
		mask-repeat: no-repeat;
		mask-position: center;
	}
	
	input[type=range] {
		-webkit-appearance: none;
		appearance: none;
		height: 16px;
		margin: 0;
		cursor: pointer;
		background-color: ${o.editorBackground};
		touch-action: pan-y;
	}
	input[type=range]:focus {
		outline: none;
	}
	input[type=range]::-webkit-slider-runnable-track {
		width: 100%;
		height: 4px;
		cursor: pointer;
		background: ${o.uiWidgetBackground};
	}
	input[type=range]::-webkit-slider-thumb {
		height: 16px;
		width: 4px;
		border-radius: 2px;
		background: ${o.primaryText};
		cursor: pointer;
		-webkit-appearance: none;
		margin-top: -6px;
	}
	input[type=range]:focus::-webkit-slider-runnable-track, input[type=range]:hover::-webkit-slider-runnable-track {
		background: ${o.uiWidgetFocus};
	}
	input[type=range]::-moz-range-track {
		width: 100%;
		height: 4px;
		cursor: pointer;
		background: ${o.uiWidgetBackground};
	}
	input[type=range]:focus::-moz-range-track, input[type=range]:hover::-moz-range-track  {
		background: ${o.uiWidgetFocus};
	}
	input[type=range]::-moz-range-thumb {
		height: 16px;
		width: 4px;
		border-radius: 2px;
		border: none;
		background: ${o.primaryText};
		cursor: pointer;
	}
	input[type=range]::-ms-track {
		width: 100%;
		height: 4px;
		cursor: pointer;
		background: ${o.uiWidgetBackground};
		border-color: transparent;
	}
	input[type=range]:focus::-ms-track, input[type=range]:hover::-ms-track {
		background: ${o.uiWidgetFocus};
	}
	input[type=range]::-ms-thumb {
		height: 16px;
		width: 4px;
		border-radius: 2px;
		background: ${o.primaryText};
		cursor: pointer;
	}
`));o.setTheme(window.localStorage.getItem("colorTheme")||"jummbox classic");let J=null,ne=(Math.random()*4294967295>>>0).toString(16),oe=!1,S,T=!1,h=1,Q=0,M=0;const e=new te;let ie=Le({style:"flex-grow: 1; margin: 0 1px; margin-left: 10px; overflow: hidden;"},""),ae=P({target:"_top",style:"margin: 0 4px;"},"✎ Edit"),U=P({href:"javascript:void(0)",style:"margin: 0 4px;"},"⎘ Copy URL"),z=P({href:"javascript:void(0)",style:"margin: 0 4px;"},"⤳ Share"),N=P({target:"_top",style:"margin: 0 4px;"},"⇱ Fullscreen"),A=!1;const u=D({style:"width: 100%; height: 100%; max-height: 50px;"}),Me=k({style:"flex-shrink: 0; display: flex; padding: 2px; width: 80px; height: 100%; box-sizing: border-box; align-items: center;"},u),re=W({d:"M 4 2 L 4 0 L 7 3 L 4 6 L 4 4 Q 2 4 2 6 Q 2 8 4 8 L 4 10 Q 0 10 0 6 Q 0 2 4 2 M 8 10 L 8 12 L 5 9 L 8 6 L 8 8 Q 10 8 10 6 Q 10 4 8 4 L 8 2 Q 12 2 12 6 Q 12 10 8 10 z"}),le=D({title:"loop",style:"background: none; flex: 0 0 12px; margin: 0 3px; width: 12px; height: 12px; display: flex;"},V({width:12,height:12,viewBox:"0 0 12 12"},re)),Se=V({style:"flex: 0 0 12px; margin: 0 1px; width: 12px; height: 12px;",viewBox:"0 0 12 12"},W({fill:o.uiWidgetBackground,d:"M 1 9 L 1 3 L 4 3 L 7 0 L 7 12 L 4 9 L 1 9 M 9 3 Q 12 6 9 9 L 8 8 Q 10.5 6 8 4 L 9 3 z"})),L=Ce({title:"volume",type:"range",value:75,min:0,max:75,step:1,style:"width: 12vw; max-width: 100px; margin: 0 1px;"}),se=V({width:12,height:12,viewBox:"0 0 12 12"},Be({cx:"5",cy:"5",r:"4.5","stroke-width":"1",stroke:"currentColor",fill:"none"}),W({stroke:"currentColor","stroke-width":"2",d:"M 8 8 L 11 11 M 5 2 L 5 8 M 2 5 L 8 5",fill:"none"})),ce=D({title:"zoom",style:"background: none; flex: 0 0 12px; margin: 0 3px; width: 12px; height: 12px; display: flex;"},se),s=V({style:"min-width: 0; min-height: 0; touch-action: pan-y pinch-zoom;"}),pe=k({style:`position: absolute; left: 0; top: 0; width: 2px; height: 100%; background: ${o.playhead}; pointer-events: none;`}),F=k({style:"display: flex; flex-grow: 1; flex-shrink: 1; position: relative;"},s,pe),v=k({style:"display: flex; flex-grow: 1; flex-shrink: 1; height: 0; position: relative; align-items: center; overflow: hidden;"},F),Te=g.rect({"pointer-events":"none",width:"90%",height:"50%",x:"5%",y:"25%",fill:o.uiWidgetBackground}),$=g.rect({"pointer-events":"none",height:"50%",width:"0%",x:"5%",y:"25%",fill:"url('#volumeGrad2')"}),E=g.rect({"pointer-events":"none",width:"2px",height:"50%",x:"5%",y:"25%",fill:o.uiWidgetFocus}),ze=g.stop({"stop-color":"lime",offset:"60%"}),$e=g.stop({"stop-color":"orange",offset:"90%"}),Ee=g.stop({"stop-color":"red",offset:"100%"}),Pe=g.linearGradient({id:"volumeGrad2",gradientUnits:"userSpaceOnUse"},ze,$e,Ee),Ve=g.defs({},Pe),We=g.svg({style:"touch-action: none; overflow: hidden; margin: auto;",width:"160px",height:"10px",preserveAspectRatio:"none"},Ve,Te,$,E);document.body.appendChild(v);document.body.appendChild(k({style:"flex-shrink: 0; height: 20vh; min-height: 22px; max-height: 70px; display: flex; align-items: center;"},Me,le,Se,L,ce,We,ie,ae,U,z,N));function ue(t,n){try{localStorage.setItem(t,n)}catch(a){console.error(a)}}function O(t){try{return localStorage.getItem(t)}catch(n){return console.error(n),null}}function Y(t,n){e.setSong(t),e.snapToStart();const a=e.song.toBase64String();ae.href="../#"+a}function de(){let t=location.hash;if(!(J==t||t=="")){J=t,t.charAt(0)=="#"&&(t=t.substring(1)),N.href=location.href;for(const n of t.split("&")){let a=n.indexOf("=");if(a!=-1){let c=n.substring(0,a),p=n.substring(a+1);switch(c){case"song":Y(p),e.song&&(ie.textContent=e.song.title);break;case"loop":e.loopRepeatCount=p!="1"?0:-1,Z();break}}else Y(t)}q()}}function Ae(){q()}function ge(){e.playing&&(S=requestAnimationFrame(ge),O("playerId")!=ne&&G(),b(),he()),oe!=e.playing&&X()}function he(){if(e.song==null){E.setAttribute("x","5%"),$.setAttribute("width","0%");return}Q--,Q<=0&&(M-=.03),e.song.outVolumeCap>M&&(M=e.song.outVolumeCap,Q=50),Re(e.song.outVolumeCap,M),e.playing||(E.setAttribute("x","5%"),$.setAttribute("width","0%"))}function Re(t,n){$.setAttribute("width",""+Math.min(144,t*144)),E.setAttribute("x",""+(8+Math.min(144,n*144)))}function G(){e.song!=null&&(S!=null&&cancelAnimationFrame(S),S=null,e.playing?(e.pause(),he()):(e.play(),ue("playerId",ne),ge())),X()}function Ie(){e.loopRepeatCount==-1?e.loopRepeatCount=0:e.loopRepeatCount=-1,Z()}function He(){ue("volume",L.value),ye()}function Qe(){T=!T,we(),q()}function Fe(t){A=!0,me(t)}function me(t){t.preventDefault(),xe(t.clientX||t.pageX)}function Oe(t){A=!0,fe(t)}function fe(t){xe(t.touches[0].clientX)}function xe(t){if(A&&e.song!=null){const n=v.getBoundingClientRect();e.playhead=e.song.barCount*(t-n.left)/(n.right-n.left),e.computeLatestModValues(),b()}}function j(){A=!1}function ye(){const t=+L.value;e.volume=Math.min(1,Math.pow(t/50,.5))*Math.pow(2,(t-75)/25)}function b(){if(e.song!=null){let t=e.playhead/e.song.barCount;pe.style.left=h*t+"px";const n=v.getBoundingClientRect();v.scrollLeft=t*(h-n.width)}}function q(){if(s.innerHTML="",e.song==null)return;const t=v.getBoundingClientRect();let n,a,c;if(T){n=t.height,a=Math.max(1,Math.min(d.pitchOctaves,Math.round(n/(12*2)))),c=a*12+1;const i=(n-1)/c,r=Math.max(8,i*4);h=Math.max(t.width,r*e.song.barCount*e.song.beatsPerBar)}else{h=t.width;const i=Math.max(1,h/(e.song.barCount*e.song.beatsPerBar)/6);n=Math.min(t.height,i*(d.maxPitch+1)+1),a=Math.max(3,Math.min(d.pitchOctaves,Math.round(n/(12*i)))),c=a*12+1}F.style.width=h+"px",F.style.height=n+"px",s.style.width=h+"px",s.style.height=n+"px";const p=h/e.song.barCount,f=p/(e.song.beatsPerBar*d.partsPerBeat),m=(n-1)/c,x=(n-1)/d.drumCount;for(let i=0;i<e.song.barCount+1;i++){const r=i==e.song.loopStart||i==e.song.loopStart+e.song.loopLength?o.loopAccent:o.uiWidgetBackground;s.appendChild(K({x:i*p-1,y:0,width:2,height:n,fill:r}))}for(let i=0;i<=a;i++)s.appendChild(K({x:0,y:i*12*m,width:h,height:m+1,fill:o.tonic,opacity:.75}));for(let i=e.song.channels.length-1-e.song.modChannelCount;i>=0;i--){const r=e.song.getChannelIsNoise(i),l=r?x:m,y=e.song.channels[i].octave,w=Math.max(0,Math.min(d.pitchOctaves-a,Math.ceil(y-a*.5)))*l*12+n-l*.5-.5;for(let B=0;B<e.song.barCount;B++){const R=e.song.getPattern(i,B);if(R==null)continue;const ve=B*p;for(let I=0;I<R.notes.length;I++){const H=R.notes[I];for(const be of H.pitches){const ke=De(be,H.start,H.pins,(l+1)/2,ve,w,f,l),_=W({d:ke,fill:o.getChannelColor(e.song,i).primaryChannel});r&&(_.style.opacity=String(.6)),s.appendChild(_)}}}}b()}function De(t,n,a,c,p,f,m,x){let i=`M ${p+m*(n+a[0].time)} ${f-t*x+c*(a[0].size/d.noteSizeMax)} `;for(let r=0;r<a.length;r++){const l=a[r],y=p+m*(n+l.time),C=f-x*(t+l.interval),w=l.size/d.noteSizeMax;i+=`L ${y} ${C-c*w} `}for(let r=a.length-1;r>=0;r--){const l=a[r],y=p+m*(n+l.time),C=f-x*(t+l.interval),w=l.size/d.noteSizeMax;i+=`L ${y} ${C+c*w} `}return i}function X(){e.playing?(u.classList.remove("playButton"),u.classList.add("pauseButton"),u.title="Pause (Space)",u.textContent="Pause"):(u.classList.remove("pauseButton"),u.classList.add("playButton"),u.title="Play (Space)",u.textContent="Play"),oe=e.playing}function Z(){re.setAttribute("fill",e.loopRepeatCount==-1?o.linkAccent:o.uiWidgetBackground)}function we(){se.style.color=T?o.linkAccent:o.uiWidgetBackground}function Ue(t){switch(t.keyCode){case 70:e.playhead=0,e.computeLatestModValues(),t.preventDefault();break;case 32:G(),e.computeLatestModValues(),t.preventDefault();break;case 219:e.goToPrevBar(),e.computeLatestModValues(),b(),t.preventDefault();break;case 221:e.goToNextBar(),e.computeLatestModValues(),b(),t.preventDefault();break}}function Ne(){let t;if(t=navigator,t.clipboard&&t.clipboard.writeText){t.clipboard.writeText(location.href).catch(()=>{window.prompt("Copy to clipboard:",location.href)});return}const n=document.createElement("textarea");n.textContent=location.href,document.body.appendChild(n),n.select();const a=document.execCommand("copy");n.remove(),a||window.prompt("Copy this:",location.href)}function Ge(){navigator.share({url:location.href})}top!==self?(U.style.display="none",z.style.display="none"):(N.style.display="none","share"in navigator||(z.style.display="none"));O("volume")!=null&&(L.value=O("volume"));ye();window.addEventListener("resize",Ae);window.addEventListener("keydown",Ue);s.addEventListener("mousedown",Fe);window.addEventListener("mousemove",me);window.addEventListener("mouseup",j);s.addEventListener("touchstart",Oe);s.addEventListener("touchmove",fe);s.addEventListener("touchend",j);s.addEventListener("touchcancel",j);u.addEventListener("click",G);le.addEventListener("click",Ie);L.addEventListener("input",He);ce.addEventListener("click",Qe);U.addEventListener("click",Ne);z.addEventListener("click",Ge);window.addEventListener("hashchange",de);de();Z();we();X();window.beepbox={Config:d,Synth:te};
