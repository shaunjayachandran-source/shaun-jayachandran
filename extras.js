// /extras.js
//
// Shared add-ons for amandacreate.com. Load on the home page AND /mywork:
//   <script src="/extras.js?v=1" defer></script>
//
// 1. Tab-away title: "Don't Forget About Amanda!" when the visitor switches tabs.
// 2. "Email Me" modal: any element with data-email-modal opens it.
//    Optional data-subject="..." pre-fills the subject line.
// 3. Video page: once the portfolio video starts playing, shows
//    "View Resume" + "Contact Amanda" buttons under it.
// 4. Video page: logs who started / got halfway / finished the video, and
//    resume clicks, to the same access log shown at /mywork/log.
// 5. Resume modal: loads the PDF only when opened, instead of on every page view.

(function () {
  "use strict";

  var RESUME_URL = "/images/Amanda-Jayachandran-Resume.pdf";

  /* ------------------------------------------------------------------
     1. Tab-away title
     ------------------------------------------------------------------ */
  var originalTitle = document.title;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      originalTitle = document.title === "Don\u2019t Forget About Amanda!" ? originalTitle : document.title;
      document.title = "Don\u2019t Forget About Amanda!";
    } else {
      document.title = originalTitle;
    }
  });

  /* ------------------------------------------------------------------
     2. Email modal
     ------------------------------------------------------------------ */
  var modal, form, statusEl, submitBtn, lastOpener;

  function buildModal() {
    modal = document.createElement("div");
    modal.className = "email-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
      '<div class="email-modal-overlay" data-email-close></div>' +
      '<div class="email-modal-panel" role="dialog" aria-modal="true" aria-labelledby="email-modal-title">' +
      '  <button type="button" class="email-modal-close" data-email-close aria-label="Close">&times;</button>' +
      '  <h2 id="email-modal-title">Email Amanda</h2>' +
      '  <p class="email-modal-sub">Amanda will reply directly to the address you enter.</p>' +
      '  <form class="email-modal-form" novalidate>' +
      '    <label class="email-field"><span>Your email</span>' +
      '      <input type="email" name="email" required autocomplete="email" maxlength="254" /></label>' +
      '    <label class="email-field"><span>Subject</span>' +
      '      <input type="text" name="subject" required maxlength="150" /></label>' +
      '    <label class="email-field"><span>Message</span>' +
      '      <textarea name="message" rows="6" required maxlength="5000"></textarea></label>' +
      // Honeypot: hidden from people, bots fill it in.
      '    <label class="email-hp" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off" /></label>' +
      '    <button type="submit" class="email-modal-submit">Send</button>' +
      '    <p class="email-modal-status" role="status" aria-live="polite"></p>' +
      '  </form>' +
      '  <div class="email-modal-done" hidden>' +
      '    <p class="email-modal-done-title">Message sent.</p>' +
      '    <p class="email-modal-done-body"></p>' +
      '    <button type="button" class="email-modal-submit" data-email-close>Close</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);

    form = modal.querySelector("form");
    statusEl = modal.querySelector(".email-modal-status");
    submitBtn = form.querySelector(".email-modal-submit");

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-email-close]")) closeModal();
    });

    modal.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeModal(); return; }
      if (e.key !== "Tab") return;
      // Keep keyboard focus inside the dialog.
      var focusables = Array.prototype.filter.call(
        modal.querySelectorAll("button, input:not([tabindex='-1']), textarea"),
        function (el) { return el.offsetParent !== null; }
      );
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    form.addEventListener("submit", onSubmit);
  }

  function openModal(subject, opener) {
    if (!modal) buildModal();
    lastOpener = opener || null;
    form.hidden = false;
    modal.querySelector(".email-modal-done").hidden = true;
    statusEl.textContent = "";
    statusEl.className = "email-modal-status";
    if (subject && !form.subject.value) form.subject.value = subject;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("email-modal-lock");
    setTimeout(function () { form.email.focus(); }, 50);
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("email-modal-lock");
    if (lastOpener && lastOpener.focus) lastOpener.focus();
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = "email-modal-status" + (isError ? " is-error" : "");
  }

  function onSubmit(e) {
    e.preventDefault();
    var email = form.email.value.trim();
    var subject = form.subject.value.trim();
    var message = form.message.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus("Enter a valid email address.", true); form.email.focus(); return; }
    if (!subject) { setStatus("Add a subject.", true); form.subject.focus(); return; }
    if (!message) { setStatus("Add a message.", true); form.message.focus(); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending\u2026";
    setStatus("");

    fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, subject: subject, message: message, website: form.website.value }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
      })
      .then(function (r) {
        if (r.res.ok && r.data.ok) {
          form.hidden = true;
          var done = modal.querySelector(".email-modal-done");
          done.querySelector(".email-modal-done-body").textContent =
            "Thanks for reaching out. Amanda will reply to " + email + ".";
          done.hidden = false;
          form.reset();
          done.querySelector("button").focus();
          return;
        }
        if (r.res.status === 429) { setStatus("Too many messages from this connection. Please try again later.", true); return; }
        setStatus(r.data.error || "Something went wrong. Please try again, or reach Amanda on LinkedIn.", true);
      })
      .catch(function () {
        setStatus("Something went wrong. Please try again, or reach Amanda on LinkedIn.", true);
      })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send";
      });
  }

  // Capture phase + stopPropagation: if a button already has an older click
  // handler in script.js (e.g. the Outlook/Gmail/Yahoo chooser), adding
  // data-email-modal to it replaces that behavior with this modal.
  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-email-modal]");
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    openModal(trigger.getAttribute("data-subject") || "", trigger);
  }, true);

  /* ------------------------------------------------------------------
     3 + 4. Video page: buttons after play, and viewing events
     ------------------------------------------------------------------ */
  var actionsShown = false;
  var sent = {};

  function viewerEmail() {
    var input = document.querySelector("#step-gate input[type='email'], input[type='email']:not(.email-modal input)");
    return input ? input.value.trim().toLowerCase() : "";
  }

  function logEvent(name) {
    if (sent[name]) return;
    sent[name] = true;
    try {
      fetch("/api/video-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: name, email: viewerEmail() }),
        keepalive: true,
        credentials: "same-origin",
      }).catch(function () {});
    } catch (err) { /* logging must never break the page */ }
  }

  function showVideoActions(video) {
    if (actionsShown) return;
    actionsShown = true;

    var actions = document.createElement("div");
    actions.className = "video-actions";
    actions.innerHTML =
      '<a class="video-actions-btn video-actions-btn--primary" href="' + RESUME_URL + '" target="_blank" rel="noopener" data-video-resume>View R\u00e9sum\u00e9</a>' +
      '<button type="button" class="video-actions-btn" data-email-modal data-subject="Following up on your portfolio">Contact Amanda</button>';

    var host = document.getElementById("step-video");
    if (host) host.appendChild(actions);
    else video.insertAdjacentElement("afterend", actions);

    requestAnimationFrame(function () { actions.classList.add("is-visible"); });

    actions.querySelector("[data-video-resume]").addEventListener("click", function () {
      logEvent("resume_click");
    });
  }

  // 'play' and 'timeupdate' don't bubble, so listen in the capture phase.
  // This works even if the <video> is created after the password is accepted.
  document.addEventListener("play", function (e) {
    if (!(e.target instanceof HTMLVideoElement)) return;
    showVideoActions(e.target);
    logEvent("video_play");
  }, true);

  document.addEventListener("timeupdate", function (e) {
    var v = e.target;
    if (!(v instanceof HTMLVideoElement) || !v.duration) return;
    if (v.currentTime / v.duration >= 0.5) logEvent("video_halfway");
  }, true);

  document.addEventListener("ended", function (e) {
    if (e.target instanceof HTMLVideoElement) logEvent("video_complete");
  }, true);

  /* ------------------------------------------------------------------
     5. Resume modal: only load the PDF when it's opened
     ------------------------------------------------------------------ */
  var resumeFrame = document.querySelector("#resume-modal iframe[data-src]");
  if (resumeFrame) {
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#resume-trigger")) return;
      if (!resumeFrame.getAttribute("src")) resumeFrame.setAttribute("src", resumeFrame.getAttribute("data-src"));
    }, true);
  }
})();
