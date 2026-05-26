import {
  loadDensities,
  scale,
  convertIngredient,
  convertInstructionText,
} from "./convert.js";
import {
  CookVoiceAssistant,
  DEFAULT_VOICE_SETTINGS,
  fetchVoiceBackend,
  fetchVoiceSettings,
  saveVoiceSettings,
  voiceAssistantSupported,
} from "./voice-assistant.js";

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
let voiceUi = { active: false, label: "", message: "", listening: false, hearing: false, hearLevel: 0 };
let voiceBackend = { enabled: false };
let voiceSettings = { ...DEFAULT_VOICE_SETTINGS };
let pendingEditImage = null;
let pendingEditImagePreview = null;
let removeEditImage = false;
let toolsMenuCloseHandler = null;

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
  closeToolsMenu();
  nav.innerHTML = links
    .map((l) => navLink(l.href, l.label, l.icon || "bookmark"))
    .join("");
}

function applyTheme(theme) {
  const dark = theme === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  localStorage.setItem("recipes-theme", dark ? "dark" : "light");
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.innerHTML = dark ? icon("sun") : icon("moon");
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
}

function bindThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  applyTheme(localStorage.getItem("recipes-theme") === "dark" ? "dark" : "light");
  btn.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

function positionToolsMenu() {
  const menu = document.getElementById("tools-menu");
  const backdrop = document.getElementById("tools-menu-backdrop");
  const header = document.querySelector(".site-header");
  if (!header) return;

  const bottom = header.getBoundingClientRect().bottom;
  if (backdrop) backdrop.style.top = `${bottom}px`;

  if (!menu) return;
  if (window.matchMedia("(max-width: 720px)").matches) {
    menu.style.top = `${bottom + 6}px`;
  } else {
    menu.style.top = "";
  }
}

function ensureToolsMenuBackdrop() {
  let backdrop = document.getElementById("tools-menu-backdrop");
  if (backdrop) return backdrop;
  backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.id = "tools-menu-backdrop";
  backdrop.className = "tools-menu-backdrop no-print";
  backdrop.hidden = true;
  backdrop.setAttribute("aria-label", "Close tools menu");
  backdrop.addEventListener("click", closeToolsMenu);
  document.body.appendChild(backdrop);
  return backdrop;
}

function closeToolsMenu() {
  const menu = document.getElementById("tools-menu");
  const btn = document.getElementById("tools-menu-btn");
  const backdrop = document.getElementById("tools-menu-backdrop");
  document.body.classList.remove("tools-menu-open");
  if (menu) menu.hidden = true;
  if (backdrop) {
    backdrop.hidden = true;
    backdrop.style.top = "";
  }
  if (btn) btn.setAttribute("aria-expanded", "false");
  if (toolsMenuCloseHandler) {
    document.removeEventListener("click", toolsMenuCloseHandler);
    window.removeEventListener("resize", positionToolsMenu);
    toolsMenuCloseHandler = null;
  }
}

function bindToolsMenu() {
  const btn = document.getElementById("tools-menu-btn");
  const menu = document.getElementById("tools-menu");
  if (!btn || !menu || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeToolsMenu();
    if (open) {
      const backdrop = ensureToolsMenuBackdrop();
      document.body.classList.add("tools-menu-open");
      menu.hidden = false;
      backdrop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      positionToolsMenu();
      window.addEventListener("resize", positionToolsMenu);
      toolsMenuCloseHandler = (ev) => {
        if (!menu.contains(ev.target) && ev.target !== btn && ev.target !== backdrop) {
          closeToolsMenu();
        }
      };
      setTimeout(() => document.addEventListener("click", toolsMenuCloseHandler), 0);
    }
  });
}

function resetEditImageState() {
  pendingEditImage = null;
  if (pendingEditImagePreview) {
    URL.revokeObjectURL(pendingEditImagePreview);
    pendingEditImagePreview = null;
  }
  removeEditImage = false;
}

async function uploadRecipeImageFile(recipeId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/recipes/${recipeId}/image`, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (res.status === 401) {
    await promptSignIn();
    return uploadRecipeImageFile(recipeId, file);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Upload failed");
  }
  return res.json();
}

function updateRecipePhotoPreview(url) {
  const box = document.getElementById("recipe-photo-preview");
  const removeBtn = document.getElementById("edit-image-remove");
  if (!box) return;
  if (url) {
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
    if (removeBtn) removeBtn.hidden = false;
  } else {
    box.innerHTML = `<span class="muted">No photo yet</span>`;
    if (removeBtn) removeBtn.hidden = true;
  }
}

function setupRecipePhotoField(recipe) {
  resetEditImageState();
  const fileInput = document.getElementById("edit-image-file");
  const chooseBtn = document.getElementById("edit-image-choose");
  const removeBtn = document.getElementById("edit-image-remove");
  const urlInput = document.getElementById("edit-image-url");

  updateRecipePhotoPreview(recipe.image_url);

  chooseBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Choose a JPEG, PNG, WebP, or GIF image.");
      fileInput.value = "";
      return;
    }
    pendingEditImage = file;
    removeEditImage = false;
    if (pendingEditImagePreview) URL.revokeObjectURL(pendingEditImagePreview);
    pendingEditImagePreview = URL.createObjectURL(file);
    updateRecipePhotoPreview(pendingEditImagePreview);
    if (urlInput) urlInput.value = "";
  });

  removeBtn?.addEventListener("click", () => {
    pendingEditImage = null;
    if (pendingEditImagePreview) {
      URL.revokeObjectURL(pendingEditImagePreview);
      pendingEditImagePreview = null;
    }
    removeEditImage = true;
    if (fileInput) fileInput.value = "";
    if (urlInput) urlInput.value = "";
    updateRecipePhotoPreview(null);
  });

  urlInput?.addEventListener("input", () => {
    if (!urlInput.value.trim()) return;
    pendingEditImage = null;
    removeEditImage = false;
    if (pendingEditImagePreview) {
      URL.revokeObjectURL(pendingEditImagePreview);
      pendingEditImagePreview = null;
    }
    updateRecipePhotoPreview(urlInput.value.trim());
  });
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
        <div class="field recipe-photo-field">
          <label>Photo</label>
          <div id="recipe-photo-preview" class="recipe-photo-preview" aria-live="polite"></div>
          <input type="file" id="edit-image-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
          <div class="recipe-photo-actions">
            <button type="button" class="btn" id="edit-image-choose">${icon("image")} Upload photo</button>
            <button type="button" class="btn" id="edit-image-remove" hidden>Remove</button>
          </div>
          <label for="edit-image-url">Or image URL</label>
          <input type="url" id="edit-image-url" placeholder="https://…" value="${escapeHtml(recipe.image_url && !String(recipe.image_url).startsWith("/api/recipe-images/") ? recipe.image_url : "")}">
          <span class="field-hint">Imported recipes may already have a URL. Upload replaces it when you save.</span>
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
  setupRecipePhotoField(recipe);
  if (recipe.image_url?.startsWith("/api/recipe-images/")) {
    updateRecipePhotoPreview(recipe.image_url);
  }

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const updated = collectEditForm(recipe, id);
    try {
      let saved = isNew
        ? await api("/api/recipes", { method: "POST", body: JSON.stringify(updated) })
        : await api(`/api/recipes/${id}`, { method: "PUT", body: JSON.stringify(updated) });
      if (pendingEditImage) {
        const { image_url } = await uploadRecipeImageFile(saved.id, pendingEditImage);
        saved = { ...saved, image_url };
      } else if (removeEditImage) {
        await api(`/api/recipes/${saved.id}/image`, { method: "DELETE" });
        saved = { ...saved, image_url: null };
      }
      resetEditImageState();
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

  let image_url = recipe.image_url;
  if (removeEditImage) image_url = null;
  else if (!pendingEditImage) {
    const urlInput = document.getElementById("edit-image-url");
    image_url = urlInput?.value.trim() || null;
  }

  return {
    ...recipe,
    id: id === "new" ? null : parseInt(id, 10),
    title: document.getElementById("edit-title").value,
    base_servings: parseInt(document.getElementById("edit-servings").value, 10) || 4,
    notes: document.getElementById("edit-notes").value || null,
    image_url,
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

function clearHeaderTools() {
  closeToolsMenu();
  const el = document.getElementById("header-tools");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function stopCookAssistant() {
  if (cookAssistant) {
    cookAssistant.stop();
    cookAssistant = null;
  }
  voiceUi = { active: false, label: "", message: "", listening: false, hearing: false, hearLevel: 0 };
  document.body.classList.remove("cook-mode");
}

function setCookNav(recipeId, { voiceBackend, wakeSupported, hasImage }) {
  nav.innerHTML = `
    <div class="cook-nav-actions">
      <div class="tools-menu-wrap">
        <button type="button" id="tools-menu-btn" class="header-nav-btn" aria-expanded="false" aria-haspopup="true" aria-controls="tools-menu">
          ${icon("tools")}<span>Tools</span>
        </button>
        <div id="tools-menu" class="tools-menu" role="menu" hidden>
          <div class="tools-menu-item" role="none">
            <span>Servings</span>
            <div class="servings-stepper">
              <button type="button" id="servings-down" class="icon-btn" aria-label="Fewer servings">${icon("remove")}</button>
              <span id="servings-val" aria-live="polite">4</span>
              <button type="button" id="servings-up" class="icon-btn" aria-label="More servings">${icon("add")}</button>
            </div>
          </div>
          <div class="tools-menu-item" role="none">
            <button type="button" id="unit-toggle" class="tools-menu-btn">${icon("units")} Units: <span id="unit-chip-label">imperial</span></button>
          </div>
          ${
            wakeSupported
              ? `<div class="tools-menu-item" role="none">
            <label><input type="checkbox" id="wake-lock"> ${icon("wakelock")} Keep screen awake</label>
          </div>`
              : ""
          }
          ${
            hasImage
              ? `<div class="tools-menu-item" role="none">
            <label><input type="checkbox" id="show-images-toggle" checked> Show recipe photo</label>
          </div>`
              : ""
          }
          <div class="tools-menu-divider" role="separator"></div>
          <button type="button" id="print-btn" class="tools-menu-btn" role="menuitem">${icon("print")} Print recipe</button>
          ${
            voiceBackend.enabled
              ? `<button type="button" id="voice-settings-open" class="tools-menu-btn" role="menuitem">${icon("settings")} Voice settings</button>`
              : ""
          }
          <button type="button" id="voice-stop-menu" class="tools-menu-btn" role="menuitem" hidden>${icon("mic")} Stop voice</button>
          <p class="tools-menu-hint">Try <strong>read dry ingredients</strong>, <strong>crust ingredients</strong>, or <strong>steps for the filling</strong>. Say <strong>hold on</strong> to pause.</p>
        </div>
      </div>
      <button type="button" id="theme-toggle" class="header-icon-btn" aria-label="Toggle color theme"></button>
      <a href="#/edit/${recipeId}" class="header-nav-link">Edit</a>
    </div>`;
  bindThemeToggle();
  bindToolsMenu();
}

function mountCookHeader({ voiceSupported }) {
  const el = document.getElementById("header-tools");
  if (!el) return;
  if (!voiceSupported) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <div id="voice-dock" class="voice-toolbar no-print" aria-live="polite">
      <p id="voice-status" class="sr-only">Tap microphone to start</p>
      <button type="button" id="voice-back" class="dock-btn" aria-label="Previous" disabled>${icon("remove")}</button>
      <span id="voice-hear-glyph" class="voice-hear-glyph" hidden aria-hidden="true" title="Listening">
        <span class="hear-bar"></span><span class="hear-bar"></span><span class="hear-bar"></span><span class="hear-bar"></span>
      </span>
      <button type="button" id="voice-listen" class="dock-btn voice-mic-btn" aria-label="Start voice assistant">${icon("mic")}</button>
      <button type="button" id="voice-next" class="dock-btn" aria-label="Next" disabled>${icon("add")}</button>
    </div>`;
}

function updateVoicePanel() {
  const dock = document.getElementById("voice-dock");
  if (!dock) return;
  dock.classList.toggle("voice-active", voiceUi.active);
  dock.classList.toggle("voice-paused", voiceUi.paused);
  dock.classList.toggle("voice-listening", voiceUi.listening && !voiceUi.paused);
  const status = document.getElementById("voice-status");
  if (status) {
    status.textContent =
      voiceUi.message ||
      (voiceUi.paused
        ? "Paused — say I'm back or let's go"
        : voiceUi.active
          ? voiceUi.label || "Listening…"
          : "Tap microphone to start");
  }
  const backBtn = document.getElementById("voice-back");
  const nextBtn = document.getElementById("voice-next");
  const listenBtn = document.getElementById("voice-listen");
  const stopMenu = document.getElementById("voice-stop-menu");
  if (backBtn) backBtn.disabled = !voiceUi.active;
  if (nextBtn) nextBtn.disabled = !voiceUi.active;
  if (listenBtn) {
    listenBtn.classList.toggle("listening", voiceUi.listening);
    listenBtn.setAttribute(
      "aria-label",
      voiceUi.active
        ? voiceUi.hearing
          ? "Hearing you…"
          : voiceUi.listening
            ? "Listening…"
            : "Speak now"
        : "Start voice assistant"
    );
  }
  const hearGlyph = document.getElementById("voice-hear-glyph");
  if (hearGlyph) {
    const showHear = voiceUi.active && voiceUi.listening && !voiceUi.paused;
    hearGlyph.hidden = !showHear;
    hearGlyph.classList.toggle("hearing-voice", showHear && voiceUi.hearing);
    hearGlyph.classList.toggle("hearing-wait", showHear && !voiceUi.hearing);
    hearGlyph.querySelectorAll(".hear-bar").forEach((bar, i) => {
      const scale = voiceUi.hearing ? 0.35 + voiceUi.hearLevel * (0.55 + (i % 3) * 0.12) : 0.3;
      bar.style.height = `${scale}rem`;
    });
  }
  if (stopMenu) stopMenu.hidden = !voiceUi.active;
}

function voiceSettingsDialogHtml() {
  const v = voiceSettings;
  const voices = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
  const voiceOpts = voices
    .map((name) => `<option value="${name}"${v.tts_voice === name ? " selected" : ""}>${name}</option>`)
    .join("");
  return `
    <label>Voice <select id="vs-voice">${voiceOpts}</select></label>
    <label>Quality <select id="vs-model">
      <option value="tts-1-hd"${v.tts_model === "tts-1-hd" ? " selected" : ""}>HD (best sound)</option>
      <option value="tts-1"${v.tts_model === "tts-1" ? " selected" : ""}>Standard (faster)</option>
    </select></label>
    <label>Style <select id="vs-verbosity">
      <option value="minimal"${v.verbosity === "minimal" ? " selected" : ""}>Minimal</option>
      <option value="normal"${v.verbosity === "normal" ? " selected" : ""}>Normal</option>
      <option value="chatty"${v.verbosity === "chatty" ? " selected" : ""}>Chatty</option>
    </select></label>
    <label>Listen window <select id="vs-listen">
      <option value="2.5"${v.listen_seconds === 2.5 ? " selected" : ""}>Short (2.5s)</option>
      <option value="3.2"${v.listen_seconds === 3.2 || !v.listen_seconds ? " selected" : ""}>Normal (3.2s)</option>
      <option value="4.5"${v.listen_seconds === 4.5 ? " selected" : ""}>Long (4.5s)</option>
    </select></label>
    <label class="toggle-row full-width">
      <input type="checkbox" id="vs-ptt" ${v.push_to_talk ? "checked" : ""}>
      <span>Push-to-talk (tap mic; no auto-listen)</span>
    </label>
    <label>Nickname <input type="text" id="vs-name" placeholder="Optional" value="${escapeHtml(v.assistant_name || "")}"></label>
    <label class="full-width">Personality <textarea id="vs-personality" rows="3">${escapeHtml(v.personality || "")}</textarea></label>
    <label class="full-width">Custom commands <span class="field-hint">phrase = action per line</span>
      <textarea id="vs-custom" rows="4" placeholder="yep = next">${escapeHtml(formatCustomCommands(v.custom_commands))}</textarea>
    </label>`;
}

function openVoiceSettingsDialog() {
  const dlg = document.getElementById("voice-settings-dialog");
  const fields = document.getElementById("vs-dialog-fields");
  if (!dlg || !fields) return;
  fields.innerHTML = voiceSettingsDialogHtml();
  dlg.showModal();
}

async function saveVoiceSettingsFromDialog() {
  const settings = {
    ...voiceSettings,
    tts_voice: document.getElementById("vs-voice")?.value || "nova",
    tts_model: document.getElementById("vs-model")?.value || "tts-1",
    use_cloud_tts: true,
    verbosity: document.getElementById("vs-verbosity")?.value || "minimal",
    listen_seconds: parseFloat(document.getElementById("vs-listen")?.value || "3.2"),
    push_to_talk: !!document.getElementById("vs-ptt")?.checked,
    prompt_once: true,
    assistant_name: document.getElementById("vs-name")?.value?.trim() || "",
    personality:
      document.getElementById("vs-personality")?.value?.trim() ||
      DEFAULT_VOICE_SETTINGS.personality,
    custom_commands: parseCustomCommands(document.getElementById("vs-custom")?.value || ""),
  };
  voiceSettings = await saveVoiceSettings(settings);
  if (cookAssistant) {
    cookAssistant.settings = { ...voiceSettings };
    cookAssistant.useCloudTts = voiceBackend.enabled && voiceSettings.use_cloud_tts;
  }
}

function formatCustomCommands(commands) {
  if (!commands?.length) return "";
  return commands
    .map((c) => {
      const phrase = (c.phrases || []).join(" | ");
      return `${phrase} = ${c.action || "next"}`;
    })
    .join("\n");
}

function parseCustomCommands(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const cmds = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*=\s*(\w+)(?:\s*:\s*(.+))?$/);
    if (!m) continue;
    const phrases = m[1].split("|").map((p) => p.trim()).filter(Boolean);
    cmds.push({ phrases, action: m[2], speech: m[3]?.trim() || "" });
  }
  return cmds;
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
  clearHeaderTools();
  document.body.classList.add("cook-mode");

  const recipe = await api(`/api/recipes/${id}`);
  cookState.servings = recipe.base_servings;
  cookState.unitSystem = recipe.unit_system || "imperial";
  cookState.showImages = !!recipe.image_url;

  const wakeSupported = "wakeLock" in navigator;
  voiceBackend = await fetchVoiceBackend();
  if (voiceBackend.enabled) voiceSettings = await fetchVoiceSettings();
  const voiceSupported = voiceAssistantSupported(voiceBackend);

  setCookNav(id, { voiceBackend, wakeSupported, hasImage: !!recipe.image_url });
  mountCookHeader({ voiceSupported });
  const servingsVal = document.getElementById("servings-val");
  if (servingsVal) servingsVal.textContent = cookState.servings;
  const unitChip = document.getElementById("unit-chip-label");
  if (unitChip) unitChip.textContent = cookState.unitSystem;

  app.innerHTML = `<div class="view cook-view">
    <article id="cook-content" class="cook-content"></article>
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
    const unitChip = document.getElementById("unit-chip-label");
    if (unitChip) unitChip.textContent = cookState.unitSystem;
    const unitBtn = document.getElementById("unit-toggle");
    if (unitBtn && !unitChip) unitBtn.textContent = cookState.unitSystem;
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
  document.getElementById("print-btn")?.addEventListener("click", () => {
    closeToolsMenu();
    document.body.classList.toggle("print-images", cookState.showImages);
    window.print();
  });
  document.getElementById("voice-settings-open")?.addEventListener("click", () => {
    closeToolsMenu();
    openVoiceSettingsDialog();
  });
  document.getElementById("vs-dialog-cancel")?.addEventListener("click", () => {
    document.getElementById("voice-settings-dialog")?.close();
  });
  document.getElementById("voice-settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await saveVoiceSettingsFromDialog();
      document.getElementById("voice-settings-dialog")?.close();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("show-images-toggle")?.addEventListener("change", (e) => {
    cookState.showImages = e.target.checked;
    drawCook();
  });

  async function startCookVoice() {
    if (cookAssistant?.active) return;
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
      backend: voiceBackend,
      settings: voiceSettings,
      getCookState: () => cookState,
      setServings: (n) => {
        cookState.servings = n;
        drawCook();
      },
      setUnitSystem: (s) => {
        cookState.unitSystem = s;
        drawCook();
      },
      onPrint: () => {
        document.body.classList.toggle("print-images", cookState.showImages);
        window.print();
      },
      onHighlight: applyVoiceHighlight,
      onStatus: (s) => {
          voiceUi = {
            active: s.active,
            paused: !!s.paused,
            label: s.label || "",
            message: s.message || (s.listening ? "Listening…" : ""),
            listening: !!s.listening,
            hearing: !!s.hearing,
            hearLevel: s.hearLevel ?? 0,
          };
        updateVoicePanel();
        if (!s.active) cookAssistant = null;
      },
    });
    updateVoicePanel();
    await cookAssistant.start();
    if (!cookAssistant?.active) updateVoicePanel();
  }

  document.getElementById("voice-stop-menu")?.addEventListener("click", () => {
    closeToolsMenu();
    stopCookAssistant();
    updateVoicePanel();
  });

  document.getElementById("voice-listen")?.addEventListener("click", async () => {
    if (cookAssistant?.active) cookAssistant.tapListen();
    else await startCookVoice();
  });

  document.getElementById("voice-next")?.addEventListener("click", () => cookAssistant?.tapNext());
  document.getElementById("voice-back")?.addEventListener("click", () => cookAssistant?.tapBack());

  updateVoicePanel();

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
  clearHeaderTools();
  document.body.classList.remove("cook-mode");
  await releaseWakeLock();
  closeToolsMenu();
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
applyTheme(localStorage.getItem("recipes-theme") === "dark" ? "dark" : "light");
await loadDensities();
if (await ensureAuth()) route();
