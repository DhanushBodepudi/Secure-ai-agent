// splash.js
// The opening screen. One click (or Enter / Space) cracks it like glass from
// the exact point you clicked; the pieces then fall away to reveal the face
// login page underneath. The face-login flow (camera, models) is started by
// this file, so it only begins after the click and never times out unseen.

(function () {
  const splash = document.getElementById("splash-screen");

  function startApp() {
    // init() is defined in app.js. It is async, so catch rejections too.
    try {
      const p = typeof init === "function" ? init() : null;
      if (p && typeof p.catch === "function") p.catch((e) => console.error(e));
    } catch (e) {
      console.error(e);
    }
  }

  // If the splash markup is missing for any reason, just start the app.
  if (!splash) {
    startApp();
    return;
  }

  const stage = splash.querySelector(".splash-stage");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let triggered = false;

  function finish() {
    window.removeEventListener("keydown", onKey);
    splash.remove();
    document.body.classList.remove("splash-active");
  }

  function trigger(x, y) {
    if (triggered) return;
    triggered = true;
    splash.classList.add("is-shattering");
    startApp();

    if (reduceMotion) {
      splash.style.transition = "opacity 0.35s ease";
      splash.style.opacity = "0";
      setTimeout(finish, 380);
      return;
    }
    shatter(x, y);
  }

  function onKey(e) {
    if (triggered) return; // never swallow keys once the splash is done
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      trigger(window.innerWidth / 2, window.innerHeight / 2);
    }
  }

  splash.addEventListener("click", (e) => trigger(e.clientX, e.clientY));
  window.addEventListener("keydown", onKey);

  // -------------------------------------------------------------------------
  // The shatter
  // -------------------------------------------------------------------------

  function shatter(cx, cy) {
    const W = window.innerWidth;
    const H = window.innerHeight;

    // Pieces get bigger the further they are from the impact point, like real
    // glass: a polar mesh of rings and sectors, with jitter so nothing is regular.
    const maxR = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.15;
    const SECTORS = 14;
    const RING_FRACTIONS = [0, 0.07, 0.15, 0.26, 0.42, 0.65, 1.0];
    const rings = RING_FRACTIONS.map((f) => f * maxR);

    const base = Math.random() * Math.PI * 2;
    const step = (Math.PI * 2) / SECTORS;
    const angles = Array.from({ length: SECTORS }, (_, s) => base + (s + (Math.random() - 0.5) * 0.5) * step);

    // V[ring][sector] = one shared vertex, so neighbouring pieces fit together with no gaps.
    const V = rings.map((r, k) =>
      angles.map((a) => {
        if (k === 0) return [cx, cy];
        const rr = r * (1 + (Math.random() - 0.5) * 0.18);
        const aa = a + (Math.random() - 0.5) * 0.12;
        return [cx + rr * Math.cos(aa), cy + rr * Math.sin(aa)];
      })
    );

    const polys = [];
    for (let s = 0; s < SECTORS; s++) {
      const n = (s + 1) % SECTORS;
      polys.push([V[0][s], V[1][s], V[1][n]]); // triangles meeting at the impact point
      for (let k = 1; k < rings.length - 1; k++) {
        const a = V[k][s], b = V[k][n], c = V[k + 1][n], d = V[k + 1][s];
        const splitIt = k >= 4 || (k === 3 && Math.random() < 0.5);
        if (splitIt) {
          if (Math.random() < 0.5) polys.push([a, b, c], [a, c, d]);
          else polys.push([a, b, d], [b, c, d]);
        } else {
          polys.push([a, b, c, d]);
        }
      }
    }

    const layer = document.createElement("div");
    layer.className = "shatter-layer";
    const anims = [];

    polys.forEach((poly) => {
      const xs = poly.map((p) => p[0]);
      const ys = poly.map((p) => p[1]);
      // Only the part of each piece that is on screen is ever needed.
      const L = Math.max(Math.min(...xs), 0);
      const T = Math.max(Math.min(...ys), 0);
      const R = Math.min(Math.max(...xs), W);
      const B = Math.min(Math.max(...ys), H);
      if (R - L < 2 || B - T < 2) return;

      const gx = poly.reduce((sum, p) => sum + p[0], 0) / poly.length;
      const gy = poly.reduce((sum, p) => sum + p[1], 0) / poly.length;

      const shard = document.createElement("div");
      shard.className = "shard";
      shard.style.left = L + "px";
      shard.style.top = T + "px";
      shard.style.width = R - L + "px";
      shard.style.height = B - T + "px";
      shard.style.clipPath =
        "polygon(" + poly.map((p) => `${(p[0] - L).toFixed(1)}px ${(p[1] - T).toFixed(1)}px`).join(",") + ")";
      shard.style.transformOrigin = `${Math.min(Math.max(gx - L, 0), R - L)}px ${Math.min(Math.max(gy - T, 0), B - T)}px`;

      // Each piece carries its own copy of the splash artwork, offset so the
      // picture stays perfectly aligned with where it was on screen.
      const content = document.createElement("div");
      content.className = "shard-content";
      content.style.left = -L + "px";
      content.style.top = -T + "px";
      content.style.width = W + "px";
      content.style.height = H + "px";
      content.appendChild(stage.cloneNode(true));
      shard.appendChild(content);

      // A faint, different tint per piece makes the facets visible.
      const sheen = document.createElement("div");
      sheen.className = "shard-sheen";
      sheen.style.background =
        Math.random() < 0.5
          ? `linear-gradient(${Math.floor(Math.random() * 360)}deg, rgba(255,255,255,0.7), rgba(255,255,255,0) 65%)`
          : `rgba(30, 80, 55, ${(0.04 + Math.random() * 0.07).toFixed(3)})`;
      shard.appendChild(sheen);
      anims.push(sheen.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" }));

      layer.appendChild(shard);

      // Pieces near the impact let go first and fall outward; far ones follow.
      const dist = Math.hypot(gx - cx, gy - cy);
      const dx = dist ? (gx - cx) / dist : 0;
      const dy = dist ? (gy - cy) / dist : 1;
      const push = 50 + Math.random() * 150;
      const fall = H * (0.55 + Math.random() * 0.55);
      const spin = (Math.random() - 0.5) * 140;
      const duration = 1000 + Math.random() * 500;
      const delay = 280 + (dist / maxR) * 240 + Math.random() * 60;

      anims.push(
        shard.animate(
          [
            { offset: 0, transform: "translate(0px,0px) rotate(0deg)", opacity: 1 },
            { offset: 0.14, transform: `translate(${dx * push * 0.2}px,${dy * push * 0.2}px) rotate(${spin * 0.08}deg)` },
            { offset: 0.65, opacity: 1 },
            { offset: 1, transform: `translate(${dx * push}px,${dy * push + fall}px) rotate(${spin}deg)`, opacity: 0 },
          ],
          { duration, delay, easing: "cubic-bezier(0.45, 0.05, 0.85, 0.5)", fill: "forwards" }
        )
      );
    });

    // Crack lines that spread outward from the impact before anything moves.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    function addLine(points, closed) {
      const d = "M" + points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L") + (closed ? " Z" : "");
      [["rgba(255,255,255,0.95)", 3], ["rgba(28,70,50,0.55)", 1.1]].forEach(([stroke, width]) => {
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", stroke);
        path.setAttribute("stroke-width", width);
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      });
    }
    for (let s = 0; s < SECTORS; s++) addLine(V.map((ring) => ring[s]), false);
    for (let k = 1; k <= 4; k++) addLine(V[k], true);

    const cracks = document.createElement("div");
    cracks.className = "shatter-cracks-wrap";
    cracks.appendChild(svg);
    anims.push(
      cracks.animate(
        [{ clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${maxR}px at ${cx}px ${cy}px)` }],
        { duration: 320, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }
      ),
      cracks.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: 320, fill: "forwards" })
    );

    const flash = document.createElement("div");
    flash.className = "shatter-flash";
    flash.style.left = cx - 180 + "px";
    flash.style.top = cy - 180 + "px";
    anims.push(
      flash.animate(
        [
          { opacity: 0.95, transform: "scale(0.3)" },
          { opacity: 0, transform: "scale(1.7)" },
        ],
        { duration: 440, easing: "ease-out", fill: "forwards" }
      )
    );

    splash.appendChild(layer);
    splash.appendChild(cracks);
    splash.appendChild(flash);
    stage.style.visibility = "hidden"; // the pieces now stand in for it, in the same frame

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      finish();
    };
    Promise.all(anims.map((a) => a.finished)).then(cleanup).catch(cleanup);
    setTimeout(cleanup, 6000); // safety net, generous so slow machines are never cut off mid-fall
  }
})();
