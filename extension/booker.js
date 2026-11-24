// SORY Booker: fills in an Active Mississauga field booking from a SORY Reserve link.
//
// A SORY link looks like .../reservation/landing/search/detail/1192#sory=<base64url JSON>, with
// { ids: [1192, 1197], ymd: "2026-11-22", start: "11:00 PM", end: "11:59 PM", attendees: 18, name: "..." }.
// For each field it sets the attendees, date and time and presses Proceed, then fills in the event
// details, the 2 "I acknowledge" field-rules questions and the purpose/music questions. It never ticks
// the waivers, signs, adds to cart or pays: the organizer does those.
(() => {
  const VERSION = "1.0.3"; // keep in step with manifest.json and BOOKER_VERSION in lib/reserve.ts
  const INSTALL_URL = "https://sory-five.vercel.app/booker/";
  const KEY = "sory-plan";
  const BASE = "/activemississauga/reservation/landing/search";
  const MAX_AGE_MS = 30 * 60 * 1000;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => {
    for (const t = Date.now(); Date.now() - t < ms; await sleep(150)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  };
  const visible = (el) => el && el.offsetParent !== null;
  const byText = (selector, text) => [...document.querySelectorAll(selector)].find((e) => visible(e) && e.textContent.trim() === text);
  const pageHas = (re) => re.test(document.body.innerText);

  // ----- plan -----
  const load = () => {
    try {
      const plan = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (plan && Date.now() - plan.created < MAX_AGE_MS) return plan;
    } catch {}
    sessionStorage.removeItem(KEY);
    return null;
  };
  const save = (plan) => sessionStorage.setItem(KEY, JSON.stringify(plan));
  const finish = () => sessionStorage.removeItem(KEY);

  // True when version a ("1.0.3") is newer than version b.
  const newer = (a, b) => {
    const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  let outdated = null;

  function readLink() {
    const m = location.hash.match(/sory=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try {
      const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      const p = JSON.parse(decodeURIComponent(escape(json)));
      if (p.v && newer(p.v, VERSION)) {
        sessionStorage.removeItem(KEY);
        outdated = p.v; // shown once the page has a body
      } else if (Array.isArray(p.ids) && p.ids.length && p.ymd && p.start && p.end) save({ ...p, next: 0, created: Date.now() });
    } catch (err) {
      console.error("SORY Booker: unreadable link", err);
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  // ----- banner -----
  function banner(html, kind = "info", button) {
    let el = document.getElementById("sory-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "sory-banner";
      el.style.cssText =
        "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;max-width:560px;width:calc(100% - 32px);" +
        "padding:12px 16px;border-radius:10px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);color:#fff";
      document.body.appendChild(el);
    }
    if (el.dataset.html === html) return; // same message: don't redraw (the loop runs every second)
    el.dataset.html = html;
    el.style.background = { info: "#4752c4", done: "#1f8b4c", error: "#c0392b" }[kind];
    el.innerHTML = `<b>SORY</b> · ${html}`;
    if (button) {
      const b = document.createElement("button");
      b.textContent = button.label;
      b.style.cssText = "margin-left:10px;padding:4px 10px;border:0;border-radius:6px;background:#fff;color:#222;cursor:pointer;font-weight:600";
      b.onclick = button.onClick;
      el.appendChild(b);
    }
    const close = document.createElement("span");
    close.textContent = " ×";
    close.style.cssText = "float:right;cursor:pointer;margin-left:8px";
    close.onclick = () => el.remove();
    el.prepend(close);
  }

  // ----- form helpers (work with the site's own React inputs and dropdowns) -----
  function setInput(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }
  // The dropdown under a question or label containing `text`.
  function dropdownFor(text) {
    let n = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.includes(text));
    while (n && !n.querySelector('[role="combobox"]')) n = n.parentElement;
    return n && n.querySelector('[role="combobox"]');
  }
  async function choose(dropdown, matches) {
    if (!dropdown) return false;
    dropdown.click();
    const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find((o) => visible(o) && matches(o.textContent.trim())), 3000);
    if (!option) return false;
    option.click();
    await sleep(1200); // the City recalculates fees after each answer
    return true;
  }

  // ----- steps -----
  const detailUrl = (id) => `${BASE}/detail/${id}`;

  // The site can reset the attendee count to 1 while it finishes loading, so set it and check it stuck.
  const attendeesBox = () => document.querySelector('input[aria-label="Number of attendees"]');
  async function setAttendees(plan) {
    const want = String(plan.attendees);
    for (let i = 0; i < 4; i++) {
      const box = attendeesBox();
      if (!box) return false;
      if (box.value === want) return true;
      setInput(box, want);
      await sleep(500);
    }
    return attendeesBox()?.value === want;
  }

  async function fillDetail(plan, id) {
    const attendees = await waitFor(attendeesBox);
    if (!attendees || pageHas(/sign in to re-check availability/i)) {
      banner("Sign in (top right) to continue. SORY carries on after you sign in.");
      return "wait";
    }
    if (plan.next === 0 && pageHas(/another reservation in progress/i)) {
      banner("You have an unfinished reservation on Active Mississauga. Clear it so this booking starts clean.", "error", {
        label: "Clear it and continue",
        onClick: () => {
          save({ ...plan, clearing: true });
          byText("button,a", "View reservation")?.click();
        },
      });
      return "wait";
    }

    banner(`Filling in field ${plan.next + 1} of ${plan.ids.length}…`);
    await sleep(1000); // let the page finish loading before typing into it
    await setAttendees(plan);
    for (const x of document.querySelectorAll('a[aria-label^="Delete the date and time"]')) {
      x.click();
      await sleep(400);
    }
    (await waitFor(() => document.querySelector(".date-patterns__placeholder-button")))?.click();

    const [y, m, d] = plan.ymd.split("-").map(Number);
    const label = `calendar ${MONTHS[m - 1]} ${d} ${y}`;
    let day = null;
    for (let i = 0; i < 3 && !day; i++) {
      day = await waitFor(() => [...document.querySelectorAll('[role="gridcell"]')].find((c) => (c.getAttribute("aria-label") || "").startsWith(label)), 1500);
      if (!day) [...document.querySelectorAll("button,a,[role=button]")].find((b) => /next month/i.test(b.getAttribute("aria-label") || ""))?.click();
    }
    if (!day) return fail(`Couldn't find ${plan.ymd} in the calendar.`);
    day.click();
    await sleep(500);

    const time = (name) => document.querySelector(`[role="combobox"][aria-label="Time range ${name} time"]`);
    if (!time("start") || !time("end")) return fail("Couldn't find the time boxes.");
    setInput(time("start"), plan.start);
    await sleep(300);
    setInput(time("end"), plan.end);
    await sleep(300);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    byText("button,a", "Apply")?.click();

    const chip = await waitFor(() => document.querySelector('a[aria-label^="Delete the date and time"]'));
    const status = chip?.getAttribute("aria-label") || "";
    if (!/Available$/.test(status)) return fail("This time isn't available any more. Run /available in Discord for current openings.");

    // Check the attendee count once more right before Proceed, and retry if the City rejects it.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await setAttendees(plan))) return fail(`Couldn't set attendees to ${plan.attendees}. Type it in the box and press Proceed.`);
      save({ ...plan, next: plan.next + 1 });
      byText("button,a", "Proceed")?.click();
      const moved = await waitFor(() => /\/form\//.test(location.pathname) || pageHas(/valid number for attendees/i), 10000);
      if (moved && /\/form\//.test(location.pathname)) return "next";
      save(plan); // still on this page: don't count this field as done
    }
    return fail(`The City didn't accept ${plan.attendees} attendees. Type it in the box and press Proceed.`);
  }

  async function fillEventDetails(plan) {
    const name = await waitFor(() => document.querySelector('input[aria-label="Input Event name"]'));
    if (!name) return false;
    if (!name.value) setInput(name, plan.name || "NASORY Runs pickup soccer");
    const type = dropdownFor("Event type");
    if (type && /select an event type/i.test(type.getAttribute("aria-label") || "")) {
      await choose(type, (t) => /Artificial Turf/i.test(t));
    }
    await sleep(500);
    return true;
  }

  async function onForm(plan) {
    if (plan.clearing) {
      byText("button,a", "Remove all resources")?.click();
      const yes = await waitFor(() => byText("button,a", "Yes"), 4000);
      yes?.click();
      await sleep(1500);
      save({ ...plan, clearing: false, next: 0 });
      location.assign(detailUrl(plan.ids[0]));
      return;
    }
    if (!(await fillEventDetails(plan))) return;

    if (plan.next < plan.ids.length) {
      // Next quarter field of a half or full field: the City adds it to this same reservation.
      banner(`Adding field ${plan.next + 1} of ${plan.ids.length}…`);
      byText("button,a", "Add another resource")?.click();
      await waitFor(() => !/\/form\//.test(location.pathname), 6000);
      location.assign(detailUrl(plan.ids[plan.next]));
      return;
    }

    // The 2 "I acknowledge" questions (field-use rules) only offer Yes.
    await choose(dropdownFor("only permitted to use the field"), (t) => t === "Yes");
    await choose(dropdownFor("move or alter the location"), (t) => t === "Yes");
    await choose(dropdownFor("purpose of your rental"), (t) => t === "Soccer");
    await choose(dropdownFor("playing music"), (t) => t === "No");
    finish();
    const total = (document.body.innerText.match(/Total\s*\$([\d,.]+)/) || [])[1];
    banner(
      `✅ Filled in${total ? ` · total <b>$${total}</b>` : ""}. Now it's your turn: tick the 2 <b>waivers</b>, sign, ` +
        `then <b>Add to cart</b> and pay.`,
      "done",
    );
    document.querySelector('input[type="checkbox"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ----- main loop: the site is a single-page app, so watch for page changes -----
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const plan = load();
      if (!plan) return;
      const path = location.pathname;
      const detail = path.match(/\/reservation\/landing\/search\/detail\/(\d+)\/?$/);
      if (/\/form\/\d+\/?$/.test(path)) {
        await onForm(plan);
      } else if (detail) {
        const want = plan.ids[plan.next];
        if (want === undefined) return;
        if (Number(detail[1]) !== want) return void location.assign(detailUrl(want));
        await fillDetail(plan, want);
      } else if (/\/reservation\/landing\/search\/?$/.test(path) && plan.next < plan.ids.length && !plan.clearing) {
        location.assign(detailUrl(plan.ids[plan.next]));
      } else if (/signin/i.test(path)) {
        banner("Sign in to continue. SORY carries on after you sign in.");
      }
    } catch (err) {
      console.error("SORY Booker", err);
      fail("Something went wrong. Finish the booking by hand, or try the link again.");
    } finally {
      busy = false;
    }
  }

  function fail(message) {
    finish();
    banner(`⚠️ ${message}`, "error");
    return "failed";
  }

  // Runs at document_start: the site's router drops the #sory=… part as it loads, so read it first.
  readLink();
  const start = () => {
    if (outdated) {
      // The link was made for a newer SORY Booker: stop rather than fill the booking the old way.
      return banner(
        `⚠️ Update SORY Booker: you have ${VERSION}, this link needs ${outdated} or later. ` +
          `Download the new version, reload it in chrome://extensions, then open the link again.`,
        "error",
        { label: "Get the update", onClick: () => window.open(INSTALL_URL, "_blank") },
      );
    }
    setInterval(tick, 800);
    tick();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
