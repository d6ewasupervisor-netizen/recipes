import {
  loadDensities,
  scale,
  convertIngredient,
  convertInstructionText,
} from "./convert.js";
import { CookVoiceAssistant, voiceAssistantSupported } from "./voice-assistant.js";

const app = document.getElementById("app");
const nav = document.getElementById("main-nav");
const authDialog = document.getElementById("auth-dialog");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authError = document.getElementById("auth-error");

let signedInEmail = null;
let wakeLock = null;
let draftRecipe = null;
let cookState = { servings: 4, unitSystem: "imperial", wakeLockOn: false, showImages: false };
let cookAssistant = null;
let voiceUi = { active: false, label: "", message: "", listening: false };

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function icon(name, cls = "") {
  return `<svg class="icon${cls ? ` ${cls}` : ""}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
}

function navLink(href, label, iconName) {
  return `<a href="${href}">${icon(iconName)}<span>${label}</span></a>`;
}

function pageHeader(title, subtitle = "") {
  return `<header class="page-header">
    <h1>${title}</h1>
    ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ""}
  </header>`;
}

function guide(text) {
  return `<aside class="guide">${icon("bookmark")}<p>${text}</p></aside>`;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers, credentials: "include" });
  if (res.status === 401) {
    await promptSignIn();
    const retry = await fetch(path, { ...options, headers, credentials: "include" });
    if (!retry.ok) throw new Error(await retry.text());
    return retry.status === 204 ? null : retry.json();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

async function fetchAuthStatus() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) throw new Error("Could not check sign-in status");
  return res.json();
}

function promptSignIn() {
  authError.classList.add("hidden");
  authError.textContent = "";
  authEmail.value = "";
  authDialog.showModal();
  const blockDismiss = (e) => e.preventDefault();
  authDialog.addEventListener("cancel", blockDismiss);
  return new Promise((resolve, reject) => {
    const onSubmit = async (e) => {
      e.preventDefault();
      authError.classList.add("hidden");
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: authEmail.value.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Sign in failed" }));
        authError.textContent = err.detail || "Sign in failed";
        authError.classList.remove("hidden");
        return;
      }
      const data = await res.json();
      signedInEmail = data.email || authEmail.value.trim().toLowerCase();
      authDialog.close();
      cleanup();
      resolve();
    };
    const cleanup = () => {
      authForm.removeEventListener("submit", onSubmit);
      authDialog.removeEventListener("cancel", blockDismiss);
    };
    authForm.addEventListener("submit", onSubmit);
    authDialog.addEventListener(
      "close",
      () => {
        cleanup();
        if (!signedInEmail) reject(new Error("Sign in required"));
      },
      { once: true }
    );
  });
}

async function ensureAuth() {
  const status = await fetchAuthStatus();
  if (!status.auth_required || status.authenticated) {
    signedInEmail = status.email || signedInEmail;
    return true;
  }
  app.innerHTML = `<div class="view auth-gate">
    ${pageHeader("Recipes", "Sign in with an authorized email to continue.")}
    <p class="muted">Use the sign-in prompt to enter your email.</p>
  </div>`;
  await promptSignIn();
  return true;
}

function setNav(links) {
  nav.innerHTML = links
    .map((l) => navLink(l.href, l.label, l.icon || "bookmark"))
    .join("");
}

function formatTime(mins) {
  if (!mins) return "";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function cardMedia(imageUrl) {
  if (imageUrl) {
    return `<div class="card-media"><img src="${escapeHtml(imageUrl)}" alt="" loading="lazy"></div>`;
  }
  return `<div class="card-media"><img src="/icon-launcher.svg" alt="" class="placeholder-icon"></div>`;
}

// --- List view ---

async function renderList() {
  setNav([{ href: "#/import", label: "Import", icon: "import" }]);

  app.innerHTML = `<div class="view list-view">
    ${pageHeader("Your recipes", "Search saved recipes or import a new one from any website.")}
    <div class="toolbar">
      <div class="search-wrap">
        ${icon("search")}
        <input type="search" id="search" placeholder="Search by name…" aria-label="Search recipes">
      </div>
      <a href="#/import" class="btn primary">${icon("import")} Import</a>
    </div>
    <div id="recipe-grid" class="recipe-grid"><p class="status-msg">Loading recipes…</p></div>
  </div>`;

  const recipes = await api("/api/recipes");
  const grid = document.getElementById("recipe-grid");

  if (!recipes.length) {
    grid.innerHTML = `<div class="empty-state">
      <img src="/icon-launcher.svg" alt="" class="empty-illustration">
      <h2>Your recipe box is empty</h2>
      <p>Start by importing a recipe from a link, or paste ingredients and steps yourself.</p>
      <ol class="steps-guide getting-started">
        <li><strong>Import</strong> Paste a URL from AllRecipes, NYT Cooking, or hundreds of other sites.</li>
        <li><strong>Edit</strong> Adjust servings, hide ingredients, group sections, and reorder steps.</li>
        <li><strong>Cook</strong> Scale on the fly, switch to metric, hands-free voice guidance, keep your screen awake, and print.</li>
      </ol>
      <a href="#/import" class="btn primary btn-lg">${icon("import")} Import your first recipe</a>
    </div>`;
    return;
  }

  function draw(filter = "") {
    const q = filter.toLowerCase();
    const filtered = recipes.filter((r) => r.title.toLowerCase().includes(q));
    grid.innerHTML = filtered.length
      ? filtered
          .map(
            (r) => `<article class="recipe-card">
          ${cardMedia(r.image_url)}
          <h2><a href="#/cook/${r.id}">${escapeHtml(r.title)}</a></h2>
          ${r.total_time ? `<p class="meta">${icon("time")} ${formatTime(r.total_time)}</p>` : ""}
          <div class="card-actions">
            <a href="#/cook/${r.id}" class="btn primary">${icon("servings")} Cook</a>
            <a href="#/edit/${r.id}" class="btn ghost">${icon("settings")} Edit</a>
          </div>
        </article>`
          )
          .join("")
      : `<p class="muted" style="padding:1rem">No recipes match your search.</p>`;
  }

  draw();
  document.getElementById("search").addEventListener("input", (e) => draw(e.target.value));
}

// --- Import view ---

function renderImport() {
  setNav([{ href: "#/", label: "Recipes", icon: "bookmark" }]);

  app.innerHTML = `<div class="view import-view">
    ${pageHeader("Import a recipe", "Paste a link from any recipe site or YouTube — we pull ingredients and steps automatically.")}
    ${guide("Supports 400+ recipe sites, JSON-LD pages, WP Recipe Maker, and YouTube (transcript + description). Manual paste is only if everything else fails.")}

    <form id="url-form" class="panel">
      <h2 class="panel-title">${icon("link")} From a URL</h2>
      <p class="panel-help">Copy the full recipe page address from your browser's address bar.</p>
      <div class="field">
        <label for="url-input">Recipe URL</label>
        <input type="url" id="url-input" placeholder="https://www.example.com/your-recipe" required>
      </div>
      <button type="submit" class="btn primary btn-lg">${icon("import")} Import from URL</button>
    </form>

    <div id="import-status"></div>

    <details id="manual-details" class="panel hidden">
      <summary class="panel-title">${icon("add")} Paste manually (last resort)</summary>
      <p class="panel-help">Only if automatic import fails. One ingredient or step per line.</p>
    <form id="manual-form">
      <div class="field">
        <label for="manual-title">Title</label>
        <input type="text" id="manual-title" placeholder="e.g. Sunday Pancakes">
      </div>
      <div class="field">
        <label for="manual-ingredients">Ingredients</label>
        <textarea id="manual-ingredients" rows="10" placeholder="1 cup all-purpose flour&#10;2 eggs&#10;1 cup milk"></textarea>
        <span class="field-hint">One ingredient per line</span>
      </div>
      <div class="field">
        <label for="manual-steps">Steps</label>
        <textarea id="manual-steps" rows="8" placeholder="Mix dry ingredients.&#10;Add wet ingredients and stir.&#10;Cook on a griddle until golden."></textarea>
        <span class="field-hint">One step per line — they'll be numbered for you</span>
      </div>
      <button type="submit" class="btn primary btn-lg">${icon("import")} Continue to editor</button>
    </form>
    </details>
  </div>`;

  const status = document.getElementById("import-status");
  const manualDetails = document.getElementById("manual-details");
  const manualForm = document.getElementById("manual-form");

  document.getElementById("url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    status.innerHTML = `<p class="status-msg">${icon("time")} Fetching and parsing recipe…</p>`;
    let res = await fetch("/api/recipes/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ url: document.getElementById("url-input").value }),
    });
    if (res.status === 401) {
      await promptSignIn();
      res = await fetch("/api/recipes/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: document.getElementById("url-input").value }),
      });
    }
    if (res.status === 422) {
      status.innerHTML = guide("We couldn't extract a recipe from that link. Try a direct recipe page URL, or expand manual paste below.");
      manualDetails.classList.remove("hidden");
      manualDetails.open = true;
      return;
    }
    if (!res.ok) {
      status.innerHTML = `<p class="error">${escapeHtml((await res.json()).detail || res.statusText)}</p>`;
      return;
    }
    draftRecipe = await res.json();
    location.hash = "#/edit/new";
  });

  manualForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.innerHTML = `<p class="status-msg">${icon("time")} Parsing your recipe…</p>`;
    try {
      const data = await api("/api/recipes/manual", {
        method: "POST",
        body: JSON.stringify({
          title: document.getElementById("manual-title").value,
          ingredients_raw: document.getElementById("manual-ingredients").value,
          steps_raw: document.getElementById("manual-steps").value,
        }),
      });
      draftRecipe = data;
      location.hash = "#/edit/new";
    } catch (err) {
      status.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    }
  });
}

// --- Edit view ---

async function loadRecipe(id) {
  if (id === "new") return draftRecipe;
  return api(`/api/recipes/${id}`);
}

function groupIngredients(ingredients) {
  const groups = new Map();
  ingredients.forEach((ing) => {
    const key = ing.group || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ing);
  });
  return groups;
}

function renderIngRow(ing, recipe) {
  const hidden = recipe.layout?.hidden_ingredient_ids?.includes(ing.id);
  return `<div class="ing-row" data-id="${escapeHtml(ing.id)}">
    <label class="ing-hide-label">
      <input type="checkbox" class="hide-ing" ${hidden ? "checked" : ""} aria-label="Hide ingredient" title="Hide when cooking">
      <span>Hide</span>
    </label>
    <div class="ing-fields">
      <div class="ing-field ing-qty-field">
        <label>Qty</label>
        <input type="text" class="ing-qty" value="${ing.quantity ?? ""}" inputmode="decimal" aria-label="Quantity">
      </div>
      <div class="ing-field ing-unit-field">
        <label>Unit</label>
        <input type="text" class="ing-unit" value="${ing.unit ?? ""}" aria-label="Unit" placeholder="cup">
      </div>
      <div class="ing-field ing-item-field">
        <label>Item</label>
        <input type="text" class="ing-item" value="${escapeHtml(ing.item)}" aria-label="Ingredient">
      </div>
      <div class="ing-field ing-group-field">
        <label>Section</label>
        <input type="text" class="ing-group" value="${escapeHtml(ing.group ?? "")}" placeholder="e.g. Frosting" aria-label="Section">
      </div>
    </div>
  </div>`;
}

function renderIngTableRow(ing, recipe) {
  const hidden = recipe.layout?.hidden_ingredient_ids?.includes(ing.id);
  return `<tr class="ing-row" data-id="${escapeHtml(ing.id)}">
    <td class="col-hide"><input type="checkbox" class="hide-ing" ${hidden ? "checked" : ""} aria-label="Hide ingredient" title="Hide when cooking"></td>
    <td class="col-qty"><input type="text" class="ing-qty" value="${ing.quantity ?? ""}" aria-label="Quantity"></td>
    <td class="col-unit"><input type="text" class="ing-unit" value="${ing.unit ?? ""}" aria-label="Unit" placeholder="cup"></td>
    <td><input type="text" class="ing-item" value="${escapeHtml(ing.item)}" aria-label="Ingredient"></td>
    <td class="col-group"><input type="text" class="ing-group" value="${escapeHtml(ing.group ?? "")}" placeholder="Section" aria-label="Group"></td>
  </tr>`;
}

function renderEditForm(recipe, id) {
  const isNew = id === "new";
  setNav([
    { href: "#/", label: "Recipes", icon: "bookmark" },
    ...(isNew ? [] : [{ href: `#/cook/${id}`, label: "Cook", icon: "servings" }]),
  ]);

  const ingGroups = groupIngredients(recipe.ingredients);
  const ingTableRows = recipe.ingredients.map((ing) => renderIngTableRow(ing, recipe)).join("");

  const ingSectionHubs = [...ingGroups.entries()]
    .map(([group, ings]) => {
      const label = group || "General";
      return `<section class="ing-section-hub" data-group="${escapeHtml(group)}">
        <h3 class="ing-section-title">${escapeHtml(label)}</h3>
        <div class="ing-cards">${ings.map((ing) => renderIngRow(ing, recipe)).join("")}</div>
      </section>`;
    })
    .join("");

  const stepRows = recipe.instructions
    .map(
      (s) => `<li draggable="true" data-step="${s.step}">
      <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
      <textarea class="step-text" rows="3" aria-label="Step ${s.step}">${escapeHtml(s.text)}</textarea>
    </li>`
    )
    .join("");

  app.innerHTML = `<div class="view edit-view">
    ${pageHeader(
      isNew ? "Review & save" : "Edit recipe",
      isNew
        ? "Check the imported details, tweak anything, then save to your collection."
        : "Update quantities, hide lines you skip, group sections, and drag steps into order."
    )}
    ${isNew ? guide("Imported recipes open here first so you can fix anything before saving.") : ""}

    <nav class="edit-hub-nav no-print" aria-label="Edit sections">
      <button type="button" class="edit-hub-tab active" data-hub="details">${icon("settings")}<span>Details</span></button>
      <button type="button" class="edit-hub-tab" data-hub="ingredients">${icon("servings")}<span>Ingredients</span></button>
      <button type="button" class="edit-hub-tab" data-hub="steps">${icon("bookmark")}<span>Steps</span></button>
    </nav>

    <form id="edit-form" class="panel">
      <div class="edit-hub active" data-hub="details">
        <div class="field">
          <label for="edit-title">Title</label>
          <input type="text" id="edit-title" value="${escapeHtml(recipe.title)}" required>
        </div>
        <div class="field">
          <label for="edit-servings">Base servings</label>
          <input type="number" id="edit-servings" value="${recipe.base_servings}" min="1">
          <span class="field-hint">Used as the default when you open Cook mode</span>
        </div>
        <div class="field">
          <label for="edit-notes">Notes</label>
          <textarea id="edit-notes" rows="3" placeholder="Family favorite, doubles well, etc.">${escapeHtml(recipe.notes ?? "")}</textarea>
        </div>
      </div>

      <div class="edit-hub" data-hub="ingredients">
        <div class="section-head">
          <h2>${icon("servings")} Ingredients</h2>
        </div>
        <p class="panel-help ing-help-desktop">Check <strong>Hide</strong> for items you don't want in cook/print view. Use <strong>Group</strong> for sections like "Frosting".</p>
        <p class="panel-help ing-help-mobile">Each section is grouped below. Tap a section to expand and edit ingredients.</p>
        <div class="ing-table-wrap ing-desktop">
          <table class="ing-table">
            <thead><tr>
              <th class="col-hide" title="Hide when cooking">Hide</th>
              <th class="col-qty">Qty</th>
              <th class="col-unit">Unit</th>
              <th>Item</th>
              <th class="col-group">Group</th>
            </tr></thead>
            <tbody id="ing-body">${ingTableRows}</tbody>
          </table>
        </div>
        <div class="ing-section-hubs ing-mobile">${ingSectionHubs}</div>
      </div>

      <div class="edit-hub" data-hub="steps">
        <div class="section-head">
          <h2>${icon("bookmark")} Steps</h2>
        </div>
        <p class="panel-help">Drag the ⋮⋮ handle to reorder steps.</p>
        <ol id="step-list" class="step-list">${stepRows}</ol>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn primary btn-lg">${icon("bookmark")} Save recipe</button>
        ${!isNew ? `<a href="#/cook/${id}" class="btn">${icon("servings")} Cook now</a>` : ""}
        ${!isNew ? `<button type="button" id="delete-btn" class="btn danger">${icon("trash")} Delete</button>` : ""}
      </div>
    </form>
  </div>`;

  setupEditHubNav();
  setupStepDragDrop();
  setupStepTextareas();
  setupIngSectionHubs();

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const updated = collectEditForm(recipe, id);
    try {
      const saved = isNew
        ? await api("/api/recipes", { method: "POST", body: JSON.stringify(updated) })
        : await api(`/api/recipes/${id}`, { method: "PUT", body: JSON.stringify(updated) });
      draftRecipe = null;
      location.hash = `#/cook/${saved.id}`;
    } catch (err) {
      alert(err.message);
    }
  });

  if (!isNew) {
    document.getElementById("delete-btn").addEventListener("click", async () => {
      if (!confirm("Delete this recipe permanently?")) return;
      await api(`/api/recipes/${id}`, { method: "DELETE" });
      location.hash = "#/";
    });
  }
}

function isMobileEditLayout() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function collectEditForm(recipe, id) {
  const hidden = [];
  const rowSelector = isMobileEditLayout() ? ".ing-mobile .ing-row" : "#ing-body .ing-row";
  const ingredients = [...document.querySelectorAll(rowSelector)].map((row) => {
    const ingId = row.dataset.id;
    if (row.querySelector(".hide-ing").checked) hidden.push(ingId);
    const qtyVal = row.querySelector(".ing-qty").value;
    return {
      id: ingId,
      raw: recipe.ingredients.find((x) => x.id === ingId)?.raw ?? "",
      quantity: qtyVal === "" ? null : parseFloat(qtyVal),
      unit: row.querySelector(".ing-unit").value || null,
      item: row.querySelector(".ing-item").value,
      density_key: recipe.ingredients.find((x) => x.id === ingId)?.density_key ?? null,
      group: row.querySelector(".ing-group").value || null,
    };
  });

  const steps = [...document.querySelectorAll("#step-list li")].map((li, i) => ({
    step: i + 1,
    text: li.querySelector(".step-text").value,
  }));

  return {
    ...recipe,
    id: id === "new" ? null : parseInt(id, 10),
    title: document.getElementById("edit-title").value,
    base_servings: parseInt(document.getElementById("edit-servings").value, 10) || 4,
    notes: document.getElementById("edit-notes").value || null,
    ingredients,
    instructions: steps,
    layout: { ...recipe.layout, hidden_ingredient_ids: hidden, step_order: steps.map((s) => s.step) },
  };
}

function setupEditHubNav() {
  const tabs = document.querySelectorAll(".edit-hub-tab");
  const hubs = document.querySelectorAll(".edit-hub");
  const storageKey = "edit-hub-active";

  function activate(hubId) {
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.hub === hubId));
    hubs.forEach((hub) => hub.classList.toggle("active", hub.dataset.hub === hubId));
    try {
      sessionStorage.setItem(storageKey, hubId);
    } catch {
      /* ignore */
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.hub));
  });

  if (window.matchMedia("(max-width: 640px)").matches) {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && [...tabs].some((t) => t.dataset.hub === saved)) activate(saved);
  }
}

function setupIngSectionHubs() {
  document.querySelectorAll(".ing-section-hub").forEach((hub, i) => {
    const title = hub.querySelector(".ing-section-title");
    const cards = hub.querySelector(".ing-cards");
    if (!title || !cards) return;

    const details = document.createElement("details");
    details.className = "ing-section-details";
    details.open = i === 0;

    const summary = document.createElement("summary");
    summary.className = "ing-section-summary";
    summary.innerHTML = title.outerHTML + `<span class="ing-section-count">${cards.children.length}</span>`;
    title.remove();

    details.appendChild(summary);
    details.appendChild(cards);
    hub.appendChild(details);
  });
}

function setupStepTextareas() {
  document.querySelectorAll(".step-text").forEach((ta) => {
    const resize = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", resize);
    resize();
  });
}

function setupStepDragDrop() {
  const list = document.getElementById("step-list");
  let dragEl = null;
  list.querySelectorAll("li").forEach((li) => {
    li.addEventListener("dragstart", () => {
      dragEl = li;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = [...list.querySelectorAll("li:not(.dragging)")].find((el) => {
        return e.clientY <= el.getBoundingClientRect().top + el.offsetHeight / 2;
      });
      if (after) list.insertBefore(dragEl, after);
      else list.appendChild(dragEl);
    });
  });
}

async function renderEdit(id) {
  try {
    const recipe = await loadRecipe(id);
    if (!recipe) {
      app.innerHTML = `<div class="empty-state">
        <h2>Nothing to edit</h2>
        <p>Import a recipe first, then you'll land here to review it.</p>
        <a href="#/import" class="btn primary">${icon("import")} Import a recipe</a>
      </div>`;
      return;
    }
    renderEditForm(recipe, id);
  } catch {
    app.innerHTML = `<p class="error">Recipe not found. <a href="#/">Back to list</a></p>`;
  }
}

// --- Cook view ---

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    return true;
  } catch {
    return false;
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

function stopCookAssistant() {
  if (cookAssistant) {
    cookAssistant.stop();
    cookAssistant = null;
  }
  voiceUi = { active: false, label: "", message: "", listening: false };
}

function updateVoicePanel() {
  const panel = document.getElementById("voice-panel");
  if (!panel) return;
  panel.classList.toggle("voice-active", voiceUi.active);
  panel.classList.toggle("voice-listening", voiceUi.listening);
  const status = document.getElementById("voice-status");
  const label = document.getElementById("voice-label");
  const btn = document.getElementById("voice-toggle");
  if (status) status.textContent = voiceUi.message || (voiceUi.active ? voiceUi.label : "Hands-free guidance");
  if (label) label.textContent = voiceUi.active ? voiceUi.label : "";
  if (btn) {
    btn.classList.toggle("primary", !voiceUi.active);
    btn.innerHTML = voiceUi.active
      ? `${icon("mic")} Stop assistant`
      : `${icon("mic")} Start voice assistant`;
  }
}

function applyVoiceHighlight(highlight) {
  document.querySelectorAll(".voice-current").forEach((el) => el.classList.remove("voice-current"));
  if (!highlight) return;
  const sel =
    highlight.phase === "ingredients"
      ? `.ing-list [data-ing-index="${highlight.index}"]`
      : `.cook-steps [data-step-index="${highlight.index}"]`;
  const el = document.querySelector(sel);
  if (el) {
    el.classList.add("voice-current");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function renderCook(id) {
  stopCookAssistant();

  setNav([
    { href: "#/", label: "Recipes", icon: "bookmark" },
    { href: `#/edit/${id}`, label: "Edit", icon: "settings" },
  ]);

  const recipe = await api(`/api/recipes/${id}`);
  cookState.servings = recipe.base_servings;
  cookState.unitSystem = recipe.unit_system || "imperial";

  const wakeSupported = "wakeLock" in navigator;
  const voiceSupported = voiceAssistantSupported();

  app.innerHTML = `<div class="view cook-view">
    ${pageHeader("Cook mode", "Big text, live scaling, and unit conversion — designed for your phone at the stove.")}

    <div class="cook-toolbar no-print">
      <div class="control-card">
        <div class="control-label">${icon("servings")} Servings</div>
        <div class="control-value">
          <button type="button" id="servings-down" class="stepper" aria-label="Fewer servings">${icon("remove")}</button>
          <span id="servings-val" aria-live="polite">${cookState.servings}</span>
          <button type="button" id="servings-up" class="stepper" aria-label="More servings">${icon("add")}</button>
        </div>
      </div>

      <div class="control-card">
        <div class="control-label">${icon("units")} Units</div>
        <button type="button" id="unit-toggle" class="btn toggle-btn" aria-label="Toggle unit system">${cookState.unitSystem}</button>
      </div>

      ${
        wakeSupported
          ? `<div class="control-card">
        <div class="control-label">${icon("wakelock")} Screen</div>
        <label class="toggle-row">
          <input type="checkbox" id="wake-lock">
          <span>Stay awake</span>
        </label>
      </div>`
          : ""
      }

      <div class="control-card">
        <div class="control-label">${icon("print")} Print</div>
        <label class="toggle-row">
          <input type="checkbox" id="print-images">
          <span>Photos</span>
        </label>
        <button type="button" id="print-btn" class="btn primary btn-block" style="margin-top:0.5rem">${icon("print")} Print</button>
      </div>

      ${
        voiceSupported
          ? `<div class="control-card voice-control-card">
        <div class="control-label">${icon("mic")} Voice</div>
        <button type="button" id="voice-toggle" class="btn btn-block">${icon("mic")} Start voice assistant</button>
      </div>`
          : ""
      }
    </div>

    ${
      voiceSupported
        ? `<section id="voice-panel" class="voice-panel no-print" aria-live="polite">
      <p id="voice-status" class="voice-status">Hands-free guidance</p>
      <p id="voice-label" class="voice-label"></p>
      <p class="voice-hint">Say <strong>next</strong> to advance, or ask e.g. “how much sugar?” “oven temperature?” “double the recipe.”</p>
    </section>`
        : `<p class="voice-unsupported no-print">Voice assistant needs Chrome or Edge on this device (microphone + speech).</p>`
    }

    <article id="cook-content" class="cook-content"></article>
    <div class="no-print">${guide(voiceSupported ? "Voice assistant reads ingredients and steps aloud. Metric mode converts volumes to grams for common ingredients." : "Metric mode converts volumes to grams for common ingredients (e.g. 1 cup flour ≈ 120 g). Temperatures in steps convert too.")}</div>
  </div>`;

  function drawCook() {
    const hidden = new Set(recipe.layout?.hidden_ingredient_ids || []);
    const visibleIngs = recipe.ingredients.filter((ing) => !hidden.has(ing.id));
    const ings = visibleIngs
      .map((ing, i) => {
        const scaled = scale(ing.quantity, recipe.base_servings, cookState.servings);
        const conv = convertIngredient(ing, cookState.unitSystem, scaled);
        return `<li data-ing-index="${i}">${escapeHtml(conv.display)}</li>`;
      })
      .join("");

    const stepOrder = recipe.layout?.step_order;
    let orderedSteps = [...recipe.instructions];
    if (stepOrder?.length) {
      const byStep = new Map(orderedSteps.map((s) => [s.step, s]));
      orderedSteps = stepOrder.map((n) => byStep.get(n)).filter(Boolean);
    } else {
      orderedSteps.sort((a, b) => a.step - b.step);
    }
    const steps = orderedSteps
      .map((s, i) => {
        const text = convertInstructionText(s.text, cookState.unitSystem);
        return `<li data-step-index="${i}">${escapeHtml(text)}</li>`;
      })
      .join("");

    const img =
      recipe.image_url && cookState.showImages
        ? `<img class="cook-image" src="${escapeHtml(recipe.image_url)}" alt="">`
        : "";

    document.getElementById("cook-content").innerHTML = `
      ${img}
      <h1>${escapeHtml(recipe.title)}</h1>
      ${recipe.notes ? `<p class="notes">${escapeHtml(recipe.notes)}</p>` : ""}
      <h2>Ingredients <span class="muted">(${cookState.servings} servings)</span></h2>
      <ul class="ing-list">${ings || "<li class='muted'>No visible ingredients</li>"}</ul>
      <h2>Instructions</h2>
      <ol class="cook-steps">${steps}</ol>
      <footer class="print-footer">${recipe.source_url ? `<p>Source: ${escapeHtml(recipe.source_url)}</p>` : ""}</footer>
    `;
    document.getElementById("servings-val").textContent = cookState.servings;
    document.getElementById("unit-toggle").textContent = cookState.unitSystem;
    if (cookAssistant) {
      applyVoiceHighlight(
        cookAssistant.active
          ? { phase: cookAssistant.phase, index: cookAssistant.index }
          : null
      );
    }
  }

  drawCook();

  document.getElementById("servings-down").addEventListener("click", () => {
    if (cookState.servings > 1) {
      cookState.servings--;
      drawCook();
    }
  });
  document.getElementById("servings-up").addEventListener("click", () => {
    cookState.servings++;
    drawCook();
  });
  document.getElementById("unit-toggle").addEventListener("click", () => {
    cookState.unitSystem = cookState.unitSystem === "imperial" ? "metric" : "imperial";
    drawCook();
  });
  document.getElementById("print-btn").addEventListener("click", () => {
    document.body.classList.toggle("print-images", cookState.showImages);
    window.print();
  });
  document.getElementById("print-images")?.addEventListener("change", (e) => {
    cookState.showImages = e.target.checked;
    drawCook();
  });

  const voiceBtn = document.getElementById("voice-toggle");
  if (voiceBtn) {
    voiceBtn.addEventListener("click", async () => {
      if (cookAssistant?.active) {
        stopCookAssistant();
        updateVoicePanel();
        return;
      }
      if (!cookState.wakeLockOn && "wakeLock" in navigator) {
        const wakeCheckbox = document.getElementById("wake-lock");
        if (wakeCheckbox) {
          wakeCheckbox.checked = true;
          cookState.wakeLockOn = true;
          await requestWakeLock();
        }
      }
      cookAssistant = new CookVoiceAssistant({
        recipe,
        getCookState: () => cookState,
        setServings: (n) => {
          cookState.servings = n;
          drawCook();
        },
        setUnitSystem: (s) => {
          cookState.unitSystem = s;
          drawCook();
        },
        onHighlight: applyVoiceHighlight,
        onStatus: (s) => {
          voiceUi = {
            active: s.active,
            label: s.label || "",
            message: s.message || (s.listening ? "Listening…" : ""),
            listening: !!s.listening,
          };
          updateVoicePanel();
          if (!s.active) cookAssistant = null;
        },
      });
      updateVoicePanel();
      await cookAssistant.start();
      if (!cookAssistant?.active) updateVoicePanel();
    });
    updateVoicePanel();
  }

  const wakeCheckbox = document.getElementById("wake-lock");
  if (wakeCheckbox) {
    wakeCheckbox.addEventListener("change", async (e) => {
      cookState.wakeLockOn = e.target.checked;
      if (cookState.wakeLockOn) await requestWakeLock();
      else await releaseWakeLock();
    });
    document.addEventListener(
      "visibilitychange",
      async () => {
        if (document.visibilityState === "visible" && cookState.wakeLockOn) await requestWakeLock();
      },
      { once: false }
    );
  }
}

// --- Router ---

async function route() {
  stopCookAssistant();
  await releaseWakeLock();
  const hash = location.hash.slice(1) || "/";
  const parts = hash.split("/").filter(Boolean);

  try {
    if (parts.length === 0) await renderList();
    else if (parts[0] === "import") renderImport();
    else if (parts[0] === "edit") await renderEdit(parts[1] || "new");
    else if (parts[0] === "cook") await renderCook(parts[1]);
    else await renderList();
  } catch (err) {
    app.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

window.addEventListener("hashchange", route);
await loadDensities();
if (await ensureAuth()) route();
