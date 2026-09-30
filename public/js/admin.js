/* Admin orchestrator. The tab registry lives HERE and only here: the buttons in
   the page are built from it, so the old problem of the tab list existing in
   three places (HTML buttons, a setTab() array and a loadActive() dispatch)
   cannot come back. Tabs are grouped by the kind of work they are: queues you
   work through day to day, settings you change rarely, and reports you read.
   Loaded last as a classic script; the tab modules declare plain globals. */

const TABS = [
  { id: "orders",    label: "Orders",    group: "Queues" },
  { id: "users",     label: "Customers", group: "Queues" },
  { id: "topups",    label: "Top-ups",   group: "Queues" },
  { id: "status",    label: "Status",    group: "Settings" },
  { id: "pricing",   label: "Pricing",   group: "Settings" },
  { id: "messaging", label: "Messaging", group: "Settings" },
  { id: "sales",     label: "Sales",     group: "Reports" },
  { id: "logs",      label: "Logs",      group: "Reports" },
];

/* One loader per tab. Only Status understands `force` (the header Refresh
   button asks the active tab to bypass its cache); every other loader ignores
   the argument. Kept as arrows so a missing module fails at click time with a
   clear error instead of at load time. */
const TAB_LOAD = {
  orders: () => loadOrders(),
  users: () => loadUsers(),
  topups: () => loadTopups(),
  logs: () => loadLogs(),
  messaging: () => loadMessaging(),
  status: (force) => loadStatus(force),
  pricing: () => loadPricing(),
  sales: () => loadSales(),
};

/* Draw the grouped tab bar. Each group is one row on a wide screen and one
   labelled run inside the single scrolling strip on a phone; the CSS decides
   which. Each button is a real tab (roving tabindex, aria-selected, controls
   its panel) instead of a bare button inside a tablist. */
function buildTabs() {
  const host = $("#adminTabs");
  if (!host) return;
  host.textContent = "";
  let row = null, list = null, groupName = null;
  for (const t of TABS) {
    if (t.group !== groupName) {
      groupName = t.group;
      row = document.createElement("div");
      row.className = "tab-group";
      const name = document.createElement("span");
      name.className = "tab-group-name";
      name.textContent = groupName;
      list = document.createElement("div");
      list.className = "tab-group-list";
      list.setAttribute("role", "tablist");
      list.setAttribute("aria-label", groupName);
      row.append(name, list);
      host.append(row);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "admin-tab";
    b.dataset.tab = t.id;
    b.id = `tab-${t.id}`;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", `${t.id}View`);
    const on = t.id === dashTab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    b.textContent = t.label;
    list.append(b);
  }
}

/* Arrow keys move between a group's tabs the way the tab pattern promises:
   focus follows the arrows and the tab activates, Home/End jump to the ends.
   Bound once per tablist after buildTabs(). */
function wireTabKeys() {
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    list.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = [...list.querySelectorAll(".admin-tab")];
      const cur = tabs.indexOf(document.activeElement);
      if (cur === -1) return;
      let next;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else if (e.key === "ArrowRight") next = (cur + 1) % tabs.length;
      else next = (cur - 1 + tabs.length) % tabs.length;
      e.preventDefault();
      tabs[next].focus();
      setTab(tabs[next].dataset.tab);
    });
  });
}

function setTab(tab) {
  dashTab = tab;
  document.querySelectorAll(".admin-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    // The tab strip scrolls on a phone, so make sure the tab the owner just
    // tapped (or arrowed to) is actually visible.
    if (on && b.scrollIntoView) b.scrollIntoView({ block: "nearest", inline: "center" });
  });
  TABS.forEach((t) => {
    const view = $(`#${t.id}View`);
    if (view) view.hidden = t.id !== tab;
  });
  loadActive();
}

function loadActive(force) {
  const load = TAB_LOAD[dashTab];
  if (load) return load(force);
  loadOrders();
}

buildTabs();
wireTabKeys();
init();
