/* Mobile menu (the three dashes in the top right).
   One shared file so every page behaves the same, and so pages that had a
   hidden nav but no button at all (/account, /product-detail) get one. */
(function () {
  var nav = document.getElementById("mainNav");
  if (!nav) return;
  var header = document.querySelector(".site-header");
  if (!header) return;

  var btn = document.getElementById("navToggle");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "navToggle";
    btn.className = "nav-toggle";
    btn.setAttribute("aria-label", "Menu");
    var wa = document.getElementById("waBtn");
    if (wa && wa.parentNode) wa.parentNode.insertBefore(btn, wa.nextSibling);
    else header.querySelector(".header-inner").appendChild(btn);
  }
  btn.innerHTML = '<span class="nav-bars" aria-hidden="true"></span>';
  btn.setAttribute("aria-controls", "mainNav");

  /* Backdrop so a tap outside closes the menu and the page cannot be
     half-read behind it. */
  var scrim = document.createElement("div");
  scrim.className = "nav-scrim";
  header.insertAdjacentElement("afterend", scrim);

  function isOpen() { return nav.classList.contains("open"); }

  function setOpen(open) {
    nav.classList.toggle("open", open);
    btn.classList.toggle("is-open", open);
    scrim.classList.toggle("show", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("nav-open", open);
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!isOpen());
  });

  /* Tapping any link closes the menu. Without this, tapping an in-page
     anchor left the menu covering the section it just scrolled to. */
  nav.addEventListener("click", function (e) {
    var t = e.target.closest("a, button");
    if (t) setOpen(false);
  });

  scrim.addEventListener("click", function () { setOpen(false); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) { setOpen(false); btn.focus(); }
  });

  /* Scrolling or rotating with the menu open left it hanging there. */
  window.addEventListener("scroll", function () { if (isOpen()) setOpen(false); }, { passive: true });

  /* Rotating to landscape or resizing past the desktop breakpoint left the mobile
     panel open on top of the desktop nav. (This used to be registered twice, with a
     comment that said the opposite of what it did.) */
  window.addEventListener("resize", function () {
    if (isOpen() && window.innerWidth > 860) setOpen(false);
  });

  /* Keyboard: the hamburger is a real button, so Enter/Space already work. */
  btn.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" && !isOpen()) { setOpen(true); var f = nav.querySelector("a,button"); if (f) f.focus(); }
  });

  setOpen(false);
})();
