import { useRef } from "react";
import { GROUP_ORDER, type GroupId } from "@/lib/dash/classes";
import { clock } from "@/lib/dash/draw";
import { ROLLS, type ClipMeta } from "@/lib/dash/storage";
import { useRoadEngine, type Snap } from "@/components/vela/use-road-engine";

function sourceLabel(source: ClipMeta["source"]) {
  if (source === "lens") return "LENS";
  return ROLLS[source].label;
}

function stamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Meter({ value, hot }: { value: number; hot?: boolean }) {
  const lit = Math.round(Math.min(1, Math.max(0, value)) * 8);
  return (
    <span className="meter" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} className={i < lit ? (hot ? "led hot" : "led on") : "led"} />
      ))}
    </span>
  );
}

function Bridge({ snap, api }: { snap: Snap; api: ReturnType<typeof useRoadEngine>["api"] }) {
  return (
    <aside className="bridge">
      <div className="bridge-scroll">
        <p className="kicker">Lens gain</p>
        <label className="fader-label">
          <span>Threshold</span>
          <span className="num">{snap.settings.conf.toFixed(2)}</span>
        </label>
        <input
          className="fader"
          type="range"
          min={0.15}
          max={0.75}
          step={0.01}
          value={snap.settings.conf}
          aria-label="Detection threshold"
          suppressHydrationWarning
          onChange={(e) => api.current.setConf(Number(e.target.value))}
        />

        <p className="kicker">Tracks</p>
        <div className="tracks">
          {GROUP_ORDER.map((g) => (
            <div className="track-row" key={g.id}>
              <button
                type="button"
                className="hw tiny"
                data-on={snap.settings.groups[g.id]}
                onClick={() => api.current.toggleGroup(g.id as GroupId)}
              >
                {g.label}
              </button>
              <Meter value={snap.peaks[g.id]} hot={g.id === "people" && snap.peaks.people > 0.45} />
              <span className="num">{snap.counts[g.id]}</span>
            </div>
          ))}
        </div>

        <p className="kicker">Motion</p>
        <div className="track-row">
          <span className="dim-label">BUMP</span>
          <Meter value={snap.motion} hot={snap.motion > 0.55} />
          <span className="num">{snap.speed.toFixed(0)}</span>
        </div>

        <p className="kicker">Speed</p>
        <p className="fine">Your speed only. A camera cannot prove how fast the other car was going.</p>
        <div className="pair">
          <button
            type="button"
            className="hw"
            data-on={snap.source === "lens"}
            onClick={() => (snap.source === "lens" ? api.current.closeLens() : api.current.openLens())}
          >
            {snap.source === "lens" ? "CLOSE LENS" : "OPEN LENS"}
          </button>
          <button
            type="button"
            className="hw"
            disabled={snap.source !== "lens"}
            onClick={() => api.current.flipFacing()}
          >
            {snap.facing === "user" ? "CABIN" : "ROAD"}
          </button>
        </div>

        <p className="kicker">Gate</p>
        <div className="pair">
          <button type="button" className="hw" data-on={snap.settings.scope} onClick={() => api.current.toggleScope()}>
            SCOPE
          </button>
          <button type="button" className="hw" data-on={snap.settings.guides} onClick={() => api.current.toggleGuides()}>
            GUIDES
          </button>
        </div>
        <button
          type="button"
          className="hw wide"
          data-on={snap.settings.witnessTake}
          onClick={() => api.current.toggleWitness()}
        >
          WITNESS TAKE {snap.settings.witnessTake ? "ON" : "OFF"}
        </button>

        <p className="engine">
          YOLO26n
          <span>
            {snap.model === "live" ? `${Math.round(snap.inferMs)} ms · ${snap.device}` : snap.model}
          </span>
        </p>
        <p className="fine">
          Add Vela to your home screen for a full-screen lens on any phone. Vision stays on the device.
        </p>
        <p className="serial">SN VELA-R1 · ROAD · MADE BY MAJORTURKEY</p>
      </div>
    </aside>
  );
}

function Dailies({ snap, api }: { snap: Snap; api: ReturnType<typeof useRoadEngine>["api"] }) {
  return (
    <section className="dailies">
      <div className="dailies-head">
        <h2>Dailies</h2>
        <button type="button" className="hw" onClick={() => api.current.setView("gate")}>
          LIVE
        </button>
      </div>
      {snap.clips.length === 0 ? (
        <p className="empty">No takes yet. Hit the tally to record.</p>
      ) : (
        <ul className="reel">
          {snap.clips.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                className="take"
                data-on={snap.playingId === clip.id}
                onClick={() => api.current.playClip(clip.id)}
              >
                <span className="take-id">
                  SC {String(clip.scene).padStart(2, "0")} · TK {String(clip.take).padStart(2, "0")}
                </span>
                <span className="take-meta">
                  {sourceLabel(clip.source)} · {clock(clip.durationMs)} · {stamp(clip.createdAt)}
                </span>
                <span className="take-tags">{clip.tags.length ? clip.tags.join("  ") : "CLEAN"}</span>
              </button>
              <div className="take-ops">
                <button type="button" className="hw tiny" data-on={clip.locked} onClick={() => api.current.toggleLock(clip.id)}>
                  {clip.locked ? "LOCKED" : "LOCK"}
                </button>
                <button
                  type="button"
                  className="hw tiny"
                  disabled={clip.locked}
                  onClick={() => api.current.deleteClip(clip.id)}
                >
                  DROP
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function VelaApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const { snap, api } = useRoadEngine(videoRef, gateRef);

  return (
    <main className="rig" data-rec={snap.recording} data-tune={snap.tune}>
      <header className="topbar">
        <div className="wordmark">
          <span className={snap.recording ? "lamp live" : snap.witness ? "lamp hot" : "lamp"} />
          <div>
            <b>VELA</b>
            <small>MADE BY MAJORTURKEY</small>
          </div>
        </div>
        <time className="tc" dateTime={snap.timecode}>
          {snap.timecode}
        </time>
        <p className="status">
          {snap.recording ? `REC ${clock(snap.recMs)}` : snap.model === "live" ? "YOLO" : snap.model === "arming" ? "ARMING" : "STANDBY"}
        </p>
      </header>

      <div className="stage">
        <section
          className="gate"
          ref={gateRef}
          data-scope={snap.settings.scope}
          data-playing={Boolean(snap.playingId)}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            preload="none"
          />
          <div className="overlays">
            {snap.settings.guides && !snap.playingId && (
              <div className="guides" aria-hidden>
                <i className="g v a" />
                <i className="g v b" />
                <i className="g h a" />
                <i className="g h horizon" />
              </div>
            )}
            {snap.tracks.map((t) => (
              <div
                key={t.id}
                className={t.hot ? "box hot" : "box"}
                style={{ left: t.left, top: t.top, width: t.width, height: t.height }}
              >
                <i className="c tl" />
                <i className="c tr" />
                <i className="c bl" />
                <i className="c br" />
                <span>
                  {t.name} {t.conf.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="vignette" />
          <div className="chips">
            <span className="chip">{snap.speed.toFixed(0)} MPH</span>
            <span className="chip">{snap.trackCount} TRACKS</span>
            <span className="chip">{snap.scene.toString().padStart(2, "0")} / {snap.take.toString().padStart(2, "0")}</span>
            {snap.witness && <span className="chip hot">WITNESS</span>}
          </div>
          {snap.playingId && (
            <button type="button" className="hw live-back" onClick={() => api.current.stopPlayback()}>
              BACK TO LIVE
            </button>
          )}
        </section>
        {snap.view === "dailies" && <Dailies snap={snap} api={api} />}
      </div>

      <button type="button" className="scrim" aria-label="Close tune" onClick={() => api.current.setTune(false)} />
      <Bridge snap={snap} api={api} />

      <footer className="transport">
        <div className="side">
          <button type="button" className="hw tune-btn" data-on={snap.tune} onClick={() => api.current.setTune(!snap.tune)}>
            TUNE
          </button>
          <button
            type="button"
            className="hw"
            data-on={snap.source === "lens"}
            onClick={() => (snap.source === "lens" ? api.current.closeLens() : api.current.openLens())}
          >
            {snap.source === "lens" ? "ROLL" : "LENS"}
          </button>
        </div>
        <button
          type="button"
          className="rec"
          aria-pressed={snap.recording}
          aria-label={snap.recording ? "Cut" : "Roll"}
          disabled={Boolean(snap.playingId)}
          onClick={() => api.current.toggleRec()}
        >
          <i />
        </button>
        <div className="side right">
          <button
            type="button"
            className="hw"
            data-on={snap.view === "dailies"}
            onClick={() => api.current.setView(snap.view === "dailies" ? "gate" : "dailies")}
          >
            DAILIES
          </button>
        </div>
        <p className="note">{snap.note}</p>
      </footer>
    </main>
  );
}
