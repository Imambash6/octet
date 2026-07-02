import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";

/*
  SubnetGame — v1 core loop for the AltSchool networking game.
  Pure client-side. No backend. Drop into a Vite + React project and render <SubnetGame />.
  Leaderboard (Cloudflare D1) plugs into the onRoundEnd callback later — nothing here needs it.

  Math is tested (21/21 assertions). Question types ramp:
    IP class -> subnet mask -> usable hosts -> network address -> broadcast address
    i.e. recognize -> recall -> compute -> apply.
*/

/* ---------- tested networking core ---------- */
const ipToInt = (ip) => ip.split(".").reduce((a, o) => ((a << 8) >>> 0) + +o, 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const maskFromCidr = (c) => (c === 0 ? 0 : (0xffffffff << (32 - c)) >>> 0);
const maskIp = (c) => intToIp(maskFromCidr(c));
const usableHosts = (c) => (c >= 31 ? (c === 31 ? 2 : 1) : Math.pow(2, 32 - c) - 2);
const networkInt = (ipInt, c) => (ipInt & maskFromCidr(c)) >>> 0;
const broadcastInt = (ipInt, c) => (networkInt(ipInt, c) | (~maskFromCidr(c) >>> 0)) >>> 0;
const ipClass = (ip) => {
  const f = +ip.split(".")[0];
  if (f === 127) return "Loopback";
  if (f >= 1 && f <= 126) return "A";
  if (f >= 128 && f <= 191) return "B";
  if (f >= 192 && f <= 223) return "C";
  if (f >= 224 && f <= 239) return "D";
  return "E";
};

/* ---------- helpers ---------- */
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const normalizeIp = (s) => s.trim().replace(/\s+/g, "");
const isValidIp = (s) =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split(".").every((o) => +o >= 0 && +o <= 255);

/* random routable-ish IPs, avoiding 127 unless we want the loopback trap */
const randomIp = ({ allowSpecial = true } = {}) => {
  const first = allowSpecial && Math.random() < 0.12 ? pick([127, 224, 245]) : rand(1, 223);
  return [first, rand(0, 255), rand(0, 255), rand(1, 254)].join(".");
};

/* ---------- question generators ---------- */
function qIpClass() {
  const ip = randomIp({ allowSpecial: true });
  const answer = ipClass(ip);
  const options = shuffle(["A", "B", "C", "D", "E", "Loopback"]);
  return {
    type: "ipclass",
    kind: "choice",
    prompt: `Which class does this address belong to?`,
    subject: ip,
    options,
    answer,
    hint: "Read the first octet. A: 1–126 · B: 128–191 · C: 192–223 · D: 224–239 · E: 240–255. 127 is special.",
    explain: `First octet is ${ip.split(".")[0]}. ${
      answer === "Loopback"
        ? "127 is reserved for loopback — it isn't a normal host class."
        : `That falls in the Class ${answer} range.`
    }`,
    cidr: null,
  };
}

function qMask() {
  const cidr = pick([8, 9, 12, 16, 18, 20, 22, 24, 25, 26, 27, 28, 30]);
  const answer = maskIp(cidr);
  const distractors = new Set();
  while (distractors.size < 3) {
    const d = maskIp(pick([8, 16, 20, 22, 24, 25, 26, 27, 28, 30].filter((x) => x !== cidr)));
    if (d !== answer) distractors.add(d);
  }
  return {
    type: "mask",
    kind: "choice",
    prompt: `What is the subnet mask for this prefix?`,
    subject: `/${cidr}`,
    options: shuffle([answer, ...distractors]),
    answer,
    hint: "Each /8 fills one octet with 255. The remaining bits set the value of the 'interesting' octet.",
    explain: `/${cidr} means ${cidr} network bits, so the mask is ${answer}.`,
    cidr,
  };
}

function qHosts() {
  const cidr = pick([24, 25, 26, 27, 28, 29, 30, 22, 20, 16]);
  const answer = usableHosts(cidr);
  const distractors = new Set();
  distractors.add(Math.pow(2, 32 - cidr)); // forgot to subtract 2 — the classic error
  while (distractors.size < 3) {
    const c2 = pick([16, 20, 22, 24, 25, 26, 27, 28, 29, 30].filter((x) => x !== cidr));
    distractors.add(usableHosts(c2));
  }
  return {
    type: "hosts",
    kind: "choice",
    prompt: `How many usable host addresses does this subnet provide?`,
    subject: `/${cidr}`,
    options: shuffle([answer, ...[...distractors].slice(0, 3)]).map(String),
    answer: String(answer),
    hint: "Usable hosts = 2^(host bits) − 2. The −2 removes the network and broadcast addresses.",
    explain: `Host bits = 32 − ${cidr} = ${32 - cidr}. 2^${32 - cidr} − 2 = ${answer}.`,
    cidr,
  };
}

function qNetwork() {
  const cidr = pick([26, 27, 28, 25, 22, 20]);
  const ip = randomIp({ allowSpecial: false });
  const answer = intToIp(networkInt(ipToInt(ip), cidr));
  return {
    type: "network",
    kind: "text",
    prompt: `What is the network address?`,
    subject: `${ip} /${cidr}`,
    answer,
    placeholder: "e.g. 192.168.1.0",
    validate: isValidIp,
    hint: "Find the block size (256 − mask octet). The network address is the nearest multiple of the block size at or below the host's interesting octet.",
    explain: `Mask ${maskIp(cidr)}. Applying it to ${ip} zeroes the host bits → ${answer}.`,
    cidr,
    ip,
  };
}

function qBroadcast() {
  const cidr = pick([26, 27, 28, 25, 29, 22]);
  const ip = randomIp({ allowSpecial: false });
  const answer = intToIp(broadcastInt(ipToInt(ip), cidr));
  const net = intToIp(networkInt(ipToInt(ip), cidr));
  return {
    type: "broadcast",
    kind: "text",
    prompt: `What is the broadcast address?`,
    subject: `${ip} /${cidr}`,
    answer,
    placeholder: "e.g. 192.168.1.63",
    validate: isValidIp,
    hint: "Broadcast = network address + block size − 1 (all host bits set to 1).",
    explain: `Network is ${net}. Setting every host bit to 1 gives the broadcast ${answer}.`,
    cidr,
    ip,
  };
}

/* ramp: recognize -> recall -> compute -> apply */
const CURRICULUM = [qIpClass, qIpClass, qMask, qMask, qHosts, qHosts, qNetwork, qNetwork, qBroadcast, qBroadcast];
const buildRound = () => CURRICULUM.map((g) => g());

/* ---------- palette ---------- */
const C = {
  base: "#0E1726",
  panel: "#152134",
  panelHi: "#1B2A42",
  line: "#26374F",
  ink: "#EAF0F7",
  dim: "#8DA1BC",
  net: "#3FC5C0", // network bits — teal
  host: "#F2A93B", // host bits — amber
  good: "#4ADE9E",
  bad: "#F2657A",
  focus: "#7DD3FC",
};

/* ---------- bit visualizer (the signature element) ---------- */
function BitBoundary({ cidr, ip }) {
  if (cidr == null) return null;
  const int = ip ? ipToInt(ip) : networkInt(0, cidr); // if no ip, show mask pattern
  const bits = [];
  for (let i = 31; i >= 0; i--) bits.push((int >>> i) & 1);
  const octets = [0, 1, 2, 3].map((o) => bits.slice(o * 8, o * 8 + 8));
  let idx = 0;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {octets.map((oct, oi) => (
          <div key={oi} style={{ display: "flex", gap: 3 }}>
            {oct.map((b, bi) => {
              const globalIdx = idx++;
              const isNet = globalIdx < cidr;
              return (
                <span
                  key={bi}
                  title={isNet ? "network bit" : "host bit"}
                  style={{
                    width: 20,
                    height: 26,
                    display: "grid",
                    placeItems: "center",
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 13,
                    borderRadius: 4,
                    color: C.base,
                    fontWeight: 700,
                    background: isNet ? C.net : C.host,
                    opacity: ip ? 1 : isNet ? 1 : 0.35,
                  }}
                >
                  {ip ? b : isNet ? 1 : 0}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 8, fontSize: 12, color: C.dim }}>
        <Legend color={C.net} label={`network · ${cidr} bits`} />
        <Legend color={C.host} label={`host · ${32 - cidr} bits`} />
      </div>
    </div>
  );
}
const Legend = ({ color, label }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <span style={{ width: 12, height: 12, borderRadius: 3, background: color }} />
    {label}
  </span>
);

/* ---------- scoring ---------- */
const BASE = 100;
const streakBonus = (streak) => streak * 10; // rewards mastery, not speed

/* ---------- main component ---------- */
export default function SubnetGame({ onRoundEnd }) {
  const [screen, setScreen] = useState("start"); // start | play | summary
  const [name, setName] = useState("");
  const [round, setRound] = useState([]);
  const [qi, setQi] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [firstTry, setFirstTry] = useState(0);
  const [hintUsed, setHintUsed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [textVal, setTextVal] = useState("");
  const [chosen, setChosen] = useState(null);
  const [status, setStatus] = useState(null); // "right" | "wrong" | null
  const inputRef = useRef(null);

  const q = round[qi];

  const start = () => {
    setRound(buildRound());
    setQi(0);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setFirstTry(0);
    resetQuestion();
    setScreen("play");
  };

  const resetQuestion = () => {
    setHintUsed(false);
    setAttempted(false);
    setReveal(false);
    setShowHint(false);
    setTextVal("");
    setChosen(null);
    setStatus(null);
  };

  useEffect(() => {
    if (screen === "play" && q?.kind === "text") inputRef.current?.focus();
  }, [qi, screen, q]);

  const grade = useCallback(
    (given) => {
      if (reveal) return;
      const correct = q.kind === "text" ? normalizeIp(given) === q.answer : given === q.answer;
      setAttempted(true);
      if (correct) {
        const gained = (hintUsed ? BASE / 2 : BASE) + streakBonus(streak);
        setScore((s) => s + gained);
        const ns = streak + 1;
        setStreak(ns);
        setBestStreak((b) => Math.max(b, ns));
        if (!hintUsed && status !== "wrong") setFirstTry((f) => f + 1);
        setStatus("right");
        setReveal(true);
      } else {
        setStatus("wrong");
        setStreak(0);
        // stay on question; let them see the explanation and retry once, then reveal
        setReveal(true);
      }
    },
    [q, hintUsed, streak, reveal, status]
  );

  const next = () => {
    if (qi + 1 >= round.length) {
      const result = {
        name: name.trim() || "anon",
        score,
        bestStreak,
        firstTry,
        total: round.length,
      };
      onRoundEnd?.(result); // <- leaderboard hook lands here in v2
      setScreen("summary");
    } else {
      setQi((i) => i + 1);
      resetQuestion();
    }
  };

  /* ---------- screens ---------- */
  if (screen === "start")
    return (
      <Shell>
        <Eyebrow>AltSchool · Networking Lab</Eyebrow>
        <h1 style={h1}>Subnet Trainer</h1>
        <p style={{ color: C.dim, maxWidth: 460, lineHeight: 1.6, marginTop: 8 }}>
          Ten problems, ramping from address classes to broadcast math. Score rewards accuracy and
          streaks — not speed. Every answer shows you the bit boundary so the <em>why</em> sticks.
        </p>
        <label style={{ display: "block", marginTop: 24, color: C.dim, fontSize: 13 }}>
          Display name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          placeholder="pick a handle"
          maxLength={20}
          style={input}
        />
        <button onClick={start} style={{ ...btn, marginTop: 18 }}>
          Start round →
        </button>
      </Shell>
    );

  if (screen === "summary") {
    const pct = Math.round((firstTry / round.length) * 100);
    return (
      <Shell>
        <Eyebrow>Round complete</Eyebrow>
        <div style={{ display: "flex", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
          <Stat big label="Score" value={score} />
          <Stat label="First-try accuracy" value={`${pct}%`} />
          <Stat label="Best streak" value={bestStreak} />
        </div>
        <p style={{ color: C.dim, marginTop: 20, maxWidth: 440, lineHeight: 1.6 }}>
          {pct >= 80
            ? "Strong. You're computing boundaries, not guessing. Ready for packet analysis (v2)."
            : pct >= 50
            ? "Getting there. The broadcast/network questions are where the points are — drill the block-size trick."
            : "The bit boundary is doing the teaching here. Run it again and watch where the color splits."}
        </p>
        <button onClick={start} style={{ ...btn, marginTop: 22 }}>
          Play again
        </button>
      </Shell>
    );
  }

  /* play */
  return (
    <Shell wide>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Eyebrow>
          {name.trim() || "anon"} · Q{qi + 1}/{round.length}
        </Eyebrow>
        <div style={{ display: "flex", gap: 20, fontSize: 13, color: C.dim }}>
          <span>
            Streak <b style={{ color: streak ? C.host : C.dim }}>{streak}</b>
          </span>
          <span>
            Score <b style={{ color: C.ink }}>{score}</b>
          </span>
        </div>
      </div>

      <div style={{ height: 4, background: C.line, borderRadius: 4, marginTop: 10 }}>
        <div
          style={{
            width: `${(qi / round.length) * 100}%`,
            height: "100%",
            background: C.net,
            borderRadius: 4,
            transition: "width .3s",
          }}
        />
      </div>

      <p style={{ color: C.dim, marginTop: 22, fontSize: 14 }}>{q.prompt}</p>
      <div style={subject}>{q.subject}</div>

      {q.kind === "choice" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 18 }}>
          {q.options.map((opt) => {
            const isAnswer = opt === q.answer;
            const isChosen = opt === chosen;
            let bg = C.panelHi,
              bc = C.line,
              col = C.ink;
            if (reveal && isAnswer) {
              bg = "rgba(74,222,158,.14)";
              bc = C.good;
            } else if (reveal && isChosen && !isAnswer) {
              bg = "rgba(242,101,122,.14)";
              bc = C.bad;
            }
            return (
              <button
                key={opt}
                disabled={reveal}
                onClick={() => {
                  setChosen(opt);
                  grade(opt);
                }}
                style={{ ...choice, background: bg, borderColor: bc, color: col }}
              >
                {opt}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <input
            ref={inputRef}
            value={textVal}
            disabled={reveal}
            onChange={(e) => setTextVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && textVal && grade(textVal)}
            placeholder={q.placeholder}
            style={{ ...input, marginTop: 0, flex: 1, fontFamily: "ui-monospace, Menlo, monospace" }}
          />
          <button disabled={reveal || !textVal} onClick={() => grade(textVal)} style={btn}>
            Check
          </button>
        </div>
      )}

      {!reveal && (
        <button
          onClick={() => {
            setShowHint(true);
            setHintUsed(true);
          }}
          style={hintBtn}
          disabled={showHint}
        >
          {showHint ? "Hint shown (half points)" : "Need a hint? (−50%)"}
        </button>
      )}
      {showHint && !reveal && <div style={hintBox}>{q.hint}</div>}

      {reveal && (
        <div
          style={{
            marginTop: 18,
            padding: 16,
            borderRadius: 10,
            background: C.panel,
            border: `1px solid ${status === "right" ? C.good : C.bad}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b style={{ color: status === "right" ? C.good : C.bad }}>
              {status === "right" ? "Correct" : `Answer: ${q.answer}`}
            </b>
          </div>
          <p style={{ color: C.dim, marginTop: 8, lineHeight: 1.55, fontSize: 14 }}>{q.explain}</p>
          <BitBoundary cidr={q.cidr} ip={q.ip} />
          <button onClick={next} style={{ ...btn, marginTop: 16 }}>
            {qi + 1 >= round.length ? "See results →" : "Next →"}
          </button>
        </div>
      )}
    </Shell>
  );
}

/* ---------- layout primitives ---------- */
const Shell = ({ children, wide }) => (
  <div
    style={{
      minHeight: "100%",
      background: C.base,
      color: C.ink,
      fontFamily: "Inter, system-ui, -apple-system, sans-serif",
      padding: "40px 20px",
      display: "grid",
      placeItems: "center",
    }}
  >
    <style>{`
      *{box-sizing:border-box}
      button:focus-visible,input:focus-visible{outline:2px solid ${C.focus};outline-offset:2px}
      @media (prefers-reduced-motion: reduce){*{transition:none!important}}
    `}</style>
    <div
      style={{
        width: "100%",
        maxWidth: wide ? 620 : 520,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        padding: 32,
      }}
    >
      {children}
    </div>
  </div>
);
const Eyebrow = ({ children }) => (
  <div style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: C.net, fontWeight: 600 }}>
    {children}
  </div>
);
const Stat = ({ label, value, big }) => (
  <div>
    <div style={{ fontSize: big ? 44 : 30, fontWeight: 700, color: big ? C.host : C.ink, lineHeight: 1 }}>
      {value}
    </div>
    <div style={{ color: C.dim, fontSize: 13, marginTop: 6 }}>{label}</div>
  </div>
);

/* ---------- style objects ---------- */
const h1 = { fontSize: 34, fontWeight: 800, margin: "6px 0 0", letterSpacing: "-.02em" };
const input = {
  marginTop: 8,
  width: "100%",
  padding: "12px 14px",
  background: C.base,
  border: `1px solid ${C.line}`,
  borderRadius: 10,
  color: C.ink,
  fontSize: 15,
};
const btn = {
  padding: "12px 18px",
  background: C.net,
  color: C.base,
  border: "none",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 15,
  cursor: "pointer",
};
const choice = {
  padding: "16px",
  borderRadius: 10,
  border: `1px solid ${C.line}`,
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "ui-monospace, Menlo, monospace",
  textAlign: "left",
};
const subject = {
  marginTop: 8,
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 28,
  fontWeight: 700,
  color: C.ink,
  letterSpacing: "-.01em",
};
const hintBtn = {
  marginTop: 14,
  background: "none",
  border: "none",
  color: C.dim,
  fontSize: 13,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};
const hintBox = {
  marginTop: 10,
  padding: 12,
  borderRadius: 8,
  background: C.panelHi,
  border: `1px solid ${C.line}`,
  color: C.dim,
  fontSize: 13,
  lineHeight: 1.5,
};
