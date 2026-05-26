import {
  loadDensities,
  scale,
  convertIngredient,
  convertInstructionText,
} from "./convert.js";

const app = document.getElementById("app");
const nav = document.getElementById("main-nav");
const passphraseDialog = document.getElementById("passphrase-dialog");
const passphraseForm = document.getElementById("passphrase-form");
const passphraseInput = document.getElementById("passphrase-input");
const passphraseCancel = document.getElementById("passphrase-cancel");

let passphrase = null;
let wakeLock = null;
let draftRecipe = null;
let cookState = { servings: 4, unitSystem: "imperial", wakeLockOn: false, showImages: false };

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
  if (passphrase) headers["X-App-Passphrase"] = passphrase;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    await promptPassphrase();
    headers["X-App-Passphrase"] = passphrase;
    const retry = await fetch(path, { ...options, headers });
    if (!retry.ok) throw new Error(await retry.text());
    return retry.status === 204 ? null : retry.json();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

function promptPassphrase() {
  return new Promise((resolve, reject) => {
    passphraseInput.value = "";
    passphraseDialog.showModal();
    const onSubmit = (e) => {
      e.preventDefault();
      passphrase = passphraseInput.value;
      passphraseDialog.close();
      cleanup();
      resolve();
    };
    const onCancel = () => {
      passphraseDialog.close();
      cleanup();
      reject(new Error("Passphrase required"));
    };
    const cleanup = () => {
      passphraseForm.removeEventListener("submit", onSubmit);
      passphraseCancel.removeEventListener("click", onCancel);
    };
    passphraseForm.addEventListener("submit", onSubmit);
    passphraseCancel.addEventListener("click", onCancel);
  });
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
        <li><strong>Cook</strong> Scale on the fly, switch to metric, keep your screen awake, and print.</li>
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
    const headers = { "Content-Type": "application/json" };
    if (passphrase) headers["X-App-Passphrase"] = passphrase;
    let res = await fetch("/api/recipes/parse", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: document.getElementById("url-input").value }),
    });
    if (res.status === 401) {
      await promptPassphrase();
      headers["X-App-Passphrase"] = passphrase;
      res = await fetch("/api/recipes/parse", {
        method: "POST",
        headers,
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

function renderEditForm(recipe, id) {
  const isNew = id === "new";
  setNav([
    { href: "#/", label: "Recipes", icon: "bookmark" },
    ...(isNew ? [] : [{ href: `#/cook/${id}`, label: "Cook", icon: "servings" }]),
  ]);

  const ingRows = recipe.ingredients
    .map(
      (ing) => `<tr data-id="${escapeHtml(ing.id)}">
      <td class="col-hide"><input type="checkbox" class="hide-ing" ${recipe.layout?.hidden_ingredient_ids?.includes(ing.id) ? "checked" : ""} aria-label="Hide ingredient" title="Hide when cooking"></td>
      <td class="col-qty"><input type="text" class="ing-qty" value="${ing.quantity ?? ""}" aria-label="Quantity"></td>
      <td class="col-unit"><input type="text" class="ing-unit" value="${ing.unit ?? ""}" aria-label="Unit" placeholder="cup"></td>
      <td><input type="text" class="ing-item" value="${escapeHtml(ing.item)}" aria-label="Ingredient"></td>
      <td class="col-group"><input type="text" class="ing-group" value="${escapeHtml(ing.group ?? "")}" placeholder="Section" aria-label="Group"></td>
    </tr>`
    )
    .join("");

  const stepRows = recipe.instructions
    .map(
      (s) => `<li draggable="true" data-step="${s.step}">
      <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
      <textarea class="step-text" rows="2" aria-label="Step ${s.step}">${escapeHtml(s.text)}</textarea>
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

    <form id="edit-form" class="panel">
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

      <div class="section-head">
        <h2>${icon("servings")} Ingredients</h2>
      </div>
      <p class="panel-help">Check <strong>Hide</strong> for items you don't want in cook/print view. Use <strong>Group</strong> for sections like "Frosting".</p>
      <div class="ing-table-wrap">
        <table class="ing-table">
          <thead><tr>
            <th class="col-hide" title="Hide when cooking">Hide</th>
            <th class="col-qty">Qty</th>
            <th class="col-unit">Unit</th>
            <th>Item</th>
            <th class="col-group">Group</th>
          </tr></thead>
          <tbody id="ing-body">${ingRows}</tbody>
        </table>
      </div>

      <div class="section-head">
        <h2>${icon("bookmark")} Steps</h2>
      </div>
      <p class="panel-help">Drag the ⋮⋮ handle to reorder steps.</p>
      <ol id="step-list" class="step-list">${stepRows}</ol>

      <div class="form-actions">
        <button type="submit" class="btn primary btn-lg">${icon("bookmark")} Save recipe</button>
        ${!isNew ? `<a href="#/cook/${id}" class="btn">${icon("servings")} Cook now</a>` : ""}
        ${!isNew ? `<button type="button" id="delete-btn" class="btn danger">${icon("trash")} Delete</button>` : ""}
      </div>
    </form>
  </div>`;

  setupStepDragDrop();

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

function collectEditForm(recipe, id) {
  const hidden = [];
  const ingredients = [...document.querySelectorAll("#ing-body tr")].map((row) => {
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

async function renderCook(id) {
  setNav([
    { href: "#/", label: "Recipes", icon: "bookmark" },
    { href: `#/edit/${id}`, label: "Edit", icon: "settings" },
  ]);

  const recipe = await api(`/api/recipes/${id}`);
  cookState.servings = recipe.base_servings;
  cookState.unitSystem = recipe.unit_system || "imperial";

  const wakeSupported = "wakeLock" in navigator;

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
    </div>

    <article id="cook-content" class="cook-content"></article>
    <div class="no-print">${guide("Metric mode converts volumes to grams for common ingredients (e.g. 1 cup flour ≈ 120 g). Temperatures in steps convert too.")}</div>
  </div>`;

  function drawCook() {
    const hidden = new Set(recipe.layout?.hidden_ingredient_ids || []);
    const ings = recipe.ingredients
      .filter((ing) => !hidden.has(ing.id))
      .map((ing) => {
        const scaled = scale(ing.quantity, recipe.base_servings, cookState.servings);
        const conv = convertIngredient(ing, cookState.unitSystem, scaled);
        return `<li>${escapeHtml(conv.display)}</li>`;
      })
      .join("");

    const steps = recipe.instructions
      .map((s) => {
        const text = convertInstructionText(s.text, cookState.unitSystem);
        return `<li>${escapeHtml(text)}</li>`;
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
route();
