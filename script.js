// ============ STATE ============
let CURRENT_USER = null;
let posts = [];
let feedMode = "foryou"; // "foryou" = algorithmic ranking (server-side), "recent" = chronological
let quotingPostId = null;
let storiesData = { own: [], tray: [] };
let storyQueue = [];
let activeStoryIndex = 0;
let storyTimer = null;
const STORY_DURATION = 4000;
let snapsData = [];
let activeSnapIndex = 0;
let conversations = [];
let notifications = [];
let openThreadUserId = null;
let threadCache = null;
let pendingPostImage = "";
let sharingTarget = null; // { type: "post" | "snap", id }
let socket = null;
let currentView = "home"; // "home" | "explore" | "bookmarks" | "analytics" | "messages"
let exploreData = [];
let bookmarksData = [];
let explorePostModalId = null;

// ============ API HELPERS ============
function backendUnreachableError() {
  const err = new Error("Can't reach the LovyApp server.");
  err.backendUnreachable = true;
  return err;
}

async function api(path, options = {}) {
  const opts = { credentials: "include", ...options };
  if (typeof opts.body === "string") {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  }

  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (networkErr) {
    // fetch() itself threw: wrong origin, server not running, etc. (e.g. opened via
    // Live Server instead of the real Node backend).
    throw backendUnreachableError();
  }

  if (res.status === 401) {
    window.location.href = "login.html";
    throw new Error("Not authenticated");
  }

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok && !contentType.includes("application/json")) {
    // Got a response, but not from our API (e.g. a static server's 404 HTML page) —
    // same "wrong server" situation as a network error.
    throw backendUnreachableError();
  }

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    // no body
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function uploadImage(file) {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch("/api/upload", { method: "POST", credentials: "include", body: form });
  if (res.status === 401) {
    window.location.href = "login.html";
    throw new Error("Not authenticated");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data.url;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function formatTimeAgo(hoursAgo) {
  if (hoursAgo < 1) return `${Math.max(1, Math.round(hoursAgo * 60))}m`;
  if (hoursAgo < 24) return `${Math.round(hoursAgo)}h`;
  return `${Math.round(hoursAgo / 24)}d`;
}

// ============ RENDER: STORIES ============
function renderStories() {
  const el = document.getElementById("stories");
  if (!el) return;
  const hasOwnStory = storiesData.own.length > 0;
  const ownImg = hasOwnStory ? storiesData.own[storiesData.own.length - 1].img : CURRENT_USER.avatar;

  const ownHtml = `
    <div class="story own${hasOwnStory ? " has-story" : ""}" data-own="true">
      <div class="story-ring"><img src="${ownImg}" alt="Your Story"></div>
      <span class="story-name">Your Story</span>
    </div>`;

  const trayHtml = storiesData.tray
    .map(
      (s) => `
    <div class="story${s.viewed ? " viewed" : ""}" data-user-id="${s.userId}">
      <div class="story-ring"><img src="${s.avatar}" alt="${escapeHtml(s.name)}"></div>
      <span class="story-name">${escapeHtml(s.name)}</span>
    </div>`
    )
    .join("");

  el.innerHTML = ownHtml + trayHtml;

  el.querySelector('.story[data-own="true"]').addEventListener("click", () => {
    if (hasOwnStory) {
      openStory({ own: true });
    } else {
      document.getElementById("story-upload-input").click();
    }
  });

  el.querySelectorAll(".story:not([data-own])").forEach((node) => {
    node.addEventListener("click", () => openStory({ own: false, userId: Number(node.dataset.userId) }));
  });
}

async function loadStories() {
  storiesData = await api("/stories");
  renderStories();
}

// ============ RENDER: SNAPS (thumbnail row) ============
function renderSnaps() {
  const el = document.getElementById("snaps");
  if (!el) return;
  el.innerHTML = snapsData
    .map(
      (s) => `
    <div class="snap" data-id="${s.id}">
      <img src="${s.thumb}" alt="${escapeHtml(s.title)}">
      <div class="snap-thumb-overlay"></div>
      <i class="uil uil-play snap-play-icon"></i>
      <div class="snap-thumb-info">
        <span class="snap-thumb-title">${escapeHtml(s.title)}</span>
        <span class="snap-thumb-views"><i class="uil uil-play"></i> ${escapeHtml(s.views)}</span>
      </div>
    </div>`
    )
    .join("");

  el.querySelectorAll(".snap").forEach((node) => {
    node.addEventListener("click", () => openSnapViewer(Number(node.dataset.id)));
  });
}

async function loadSnaps() {
  const { snaps } = await api("/snaps");
  snapsData = snaps;
  renderSnaps();
}

// ============ SNAP VIEWER (TikTok-style) ============
function snapSlideHtml(s) {
  return `
    <div class="snap-slide" data-id="${s.id}">
      <img src="${s.thumb}" alt="${escapeHtml(s.title)}">
      <div class="snap-slide-gradient"></div>
      <div class="snap-info">
        <div class="snap-author">
          <div class="profile-photo"><img src="${s.avatar}" alt="${escapeHtml(s.author)}"></div>
          <span>${escapeHtml(s.author)}</span>
        </div>
        <div class="snap-title">${escapeHtml(s.title)}</div>
        <div class="snap-views"><i class="uil uil-play"></i> ${escapeHtml(s.views)} views</div>
      </div>
      <div class="snap-actions">
        <button class="snap-action-btn like-action${s.liked ? " liked" : ""}"><i class="uil uil-heart"></i><span>${s.likes}</span></button>
        <button class="snap-action-btn comment-action"><i class="uil uil-comment-dots"></i><span>${s.comments}</span></button>
        <button class="snap-action-btn repost-action${s.reposted ? " reposted" : ""}"><i class="uil uil-repeat"></i><span>${s.reposts}</span></button>
        <button class="snap-action-btn share-action"><i class="uil uil-share-alt"></i><span>${s.shares}</span></button>
      </div>
    </div>`;
}

function renderSnapViewer() {
  const track = document.getElementById("snap-viewer-track");
  track.innerHTML = snapsData.map(snapSlideHtml).join("");

  track.querySelectorAll(".snap-slide").forEach((node) => {
    const id = Number(node.dataset.id);

    node.querySelector(".like-action").addEventListener("click", async () => {
      try {
        const { snap } = await api(`/snaps/${id}/like`, { method: "POST" });
        patchSnap(snap);
      } catch (err) {
        showToast(err.message);
      }
    });

    node.querySelector(".comment-action").addEventListener("click", async () => {
      const text = window.prompt("Write a comment:");
      if (!text || !text.trim()) return;
      try {
        const { snap } = await api(`/snaps/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) });
        patchSnap(snap);
      } catch (err) {
        showToast(err.message);
      }
    });

    node.querySelector(".repost-action").addEventListener("click", async () => {
      try {
        const { snap } = await api(`/snaps/${id}/repost`, { method: "POST" });
        patchSnap(snap);
      } catch (err) {
        showToast(err.message);
      }
    });

    node.querySelector(".share-action").addEventListener("click", () => openShareModal("snap", id));
  });

  setActiveSnapVisual(activeSnapIndex);
}

function patchSnap(updated) {
  const idx = snapsData.findIndex((s) => s.id === updated.id);
  if (idx !== -1) snapsData[idx] = { ...snapsData[idx], ...updated };
  renderSnaps();
  const track = document.getElementById("snap-viewer-track");
  if (track && track.querySelector(".snap-slide")) renderSnapViewer();
}

function setActiveSnapVisual(index) {
  const slides = document.querySelectorAll("#snap-viewer-track .snap-slide");
  slides.forEach((slide, i) => slide.classList.toggle("active", i === index));
}

function showSnapAt(index) {
  activeSnapIndex = index;
  setActiveSnapVisual(index);
  const snap = snapsData[index];
  if (snap) api(`/snaps/${snap.id}/view`, { method: "POST" }).catch(() => {});
}

function openSnapViewer(snapId) {
  const index = snapsData.findIndex((s) => s.id === snapId);
  if (index === -1) return;
  renderSnapViewer();
  showSnapAt(index);
  document.getElementById("snap-viewer").classList.add("show");
}

function closeSnapViewer() {
  document.getElementById("snap-viewer").classList.remove("show");
  renderSnaps();
}

function nextSnap() {
  if (activeSnapIndex < snapsData.length - 1) showSnapAt(activeSnapIndex + 1);
}

function prevSnap() {
  if (activeSnapIndex > 0) showSnapAt(activeSnapIndex - 1);
}

// ============ FEED ============
async function loadFeed() {
  const { posts: fetched } = await api(`/posts/feed?mode=${feedMode}`);
  posts = fetched;
  renderFeed();
}

// Every post card, wherever it's shown (Home, Bookmarks, Explore), is kept in sync
// through this one function so an action taken in one view is reflected everywhere.
function patchPostEverywhere(updated) {
  [posts, bookmarksData, exploreData].forEach((arr) => {
    const idx = arr.findIndex((p) => p.id === updated.id);
    if (idx !== -1) arr[idx] = { ...arr[idx], ...updated, badge: updated.badge || arr[idx].badge };
  });
  if (updated.saved === false) {
    bookmarksData = bookmarksData.filter((p) => p.id !== updated.id);
  }

  renderFeed();
  if (currentView === "bookmarks") renderBookmarks();
  if (currentView === "explore") renderExploreGrid();
  if (explorePostModalId === updated.id) renderExplorePostModal(updated);
}

function findPostById(id) {
  return posts.find((p) => p.id === id) || bookmarksData.find((p) => p.id === id) || exploreData.find((p) => p.id === id);
}

function quoteEmbedHtml(original) {
  if (!original) return "";
  return `
    <div class="quote-embed" data-quoted-id="${original.id}">
      <div class="quote-embed-header">
        <div class="profile-photo"><img src="${original.avatar}" alt="${escapeHtml(original.author)}"></div>
        <span>${escapeHtml(original.author)}</span>
      </div>
      <div class="quote-embed-caption">${escapeHtml(original.caption)}</div>
      ${original.image ? `<img src="${original.image}" alt="${escapeHtml(original.author)}'s post">` : ""}
    </div>`;
}

function postCardHtml(post) {
  return `
    <div class="post" data-id="${post.id}">
      ${post.reposted ? `<div class="repost-banner"><i class="uil uil-repeat"></i> You reposted</div>` : ""}
      <div class="post-header">
        <div class="profile-photo"><img src="${post.avatar}" alt="${escapeHtml(post.author)}"></div>
        <div class="post-author-info">
          <div class="post-author-name">${escapeHtml(post.author)}</div>
          <div class="post-meta">
            <span>${formatTimeAgo(post.hoursAgo)} ago</span>
            ${post.badge ? `<span class="post-badge"><i class="uil ${post.badge.icon}"></i> ${escapeHtml(post.badge.label)}</span>` : ""}
          </div>
        </div>
        <i class="uil uil-ellipsis-h post-options"></i>
      </div>
      ${post.quoteOf ? "" : post.image ? `<img class="post-image" src="${post.image}" alt="${escapeHtml(post.author)}'s post">` : ""}
      <div class="post-caption"><span class="post-author-name">${escapeHtml(post.author)}</span>${escapeHtml(post.caption)}</div>
      ${post.quoted ? quoteEmbedHtml(post.quoted) : ""}
      <div class="post-actions">
        <span class="action like-action${post.liked ? " liked" : ""}"><i class="uil uil-heart"></i> ${post.likes}</span>
        <span class="action comment-action"><i class="uil uil-comment-dots"></i> ${post.comments}</span>
        <div class="action repost-action${post.reposted ? " reposted" : ""}">
          <i class="uil uil-repeat"></i> ${post.reposts}
          <div class="repost-menu">
            ${
              post.reposted
                ? `<button class="undo-repost"><i class="uil uil-times-circle"></i> Undo Repost</button>`
                : `<button class="do-repost"><i class="uil uil-repeat"></i> Repost</button>`
            }
            <button class="do-quote"><i class="uil uil-pen"></i> Quote</button>
          </div>
        </div>
        <span class="action share-action"><i class="uil uil-share-alt"></i> ${post.shares}</span>
        <span class="action save-action${post.saved ? " saved" : ""}"><i class="uil uil-bookmark"></i></span>
      </div>
    </div>`;
}

// Attaches all the interaction handlers to a rendered post card. `onUpdate` receives
// the fresh post object after every action so each view can decide how to re-render.
function wirePostCard(node, post, onUpdate) {
  const id = post.id;

  node.querySelector(".like-action").addEventListener("click", async () => {
    try {
      const { post } = await api(`/posts/${id}/like`, { method: "POST" });
      onUpdate(post);
    } catch (err) {
      showToast(err.message);
    }
  });

  node.querySelector(".comment-action").addEventListener("click", async () => {
    const text = window.prompt("Write a comment:");
    if (!text || !text.trim()) return;
    try {
      const { post } = await api(`/posts/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) });
      onUpdate(post);
    } catch (err) {
      showToast(err.message);
    }
  });

  node.querySelector(".save-action").addEventListener("click", async () => {
    try {
      const { post } = await api(`/posts/${id}/save`, { method: "POST" });
      onUpdate(post);
    } catch (err) {
      showToast(err.message);
    }
  });

  node.querySelector(".share-action").addEventListener("click", () => openShareModal("post", id));

  const repostAction = node.querySelector(".repost-action");
  const repostMenu = node.querySelector(".repost-menu");
  repostAction.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = repostMenu.classList.contains("show");
    closeAllRepostMenus();
    if (!isOpen) repostMenu.classList.add("show");
  });
  repostMenu.addEventListener("click", (e) => e.stopPropagation());

  const doRepost = repostMenu.querySelector(".do-repost");
  if (doRepost) {
    doRepost.addEventListener("click", async () => {
      try {
        const { post } = await api(`/posts/${id}/repost`, { method: "POST" });
        onUpdate(post);
      } catch (err) {
        showToast(err.message);
      }
    });
  }
  const undoRepost = repostMenu.querySelector(".undo-repost");
  if (undoRepost) {
    undoRepost.addEventListener("click", async () => {
      try {
        const { post } = await api(`/posts/${id}/repost`, { method: "POST" });
        onUpdate(post);
      } catch (err) {
        showToast(err.message);
      }
    });
  }
  repostMenu.querySelector(".do-quote").addEventListener("click", () => openQuoteModal(id));
}

function renderFeed() {
  const el = document.getElementById("feed");
  if (!el) return;
  el.innerHTML = posts.map(postCardHtml).join("");
  el.querySelectorAll(".post").forEach((node) => {
    const post = posts.find((p) => p.id === Number(node.dataset.id));
    wirePostCard(node, post, patchPostEverywhere);
  });
}

function setupFeedTabs() {
  document.querySelectorAll(".feed-tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      document.querySelectorAll(".feed-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      feedMode = tab.dataset.mode;
      try {
        await loadFeed();
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

// ============ VIEW SWITCHING (sidebar navigation) ============
const VIEWS = ["home", "explore", "bookmarks", "analytics", "messages"];

function switchView(view) {
  currentView = view;
  VIEWS.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle("active", v === view);
  });
  document.querySelectorAll(".sidebar .menu.item").forEach((item) => item.classList.remove("active"));
  const navItem = document.getElementById(`nav-${view}`);
  if (navItem) navItem.classList.add("active");

  if (view === "explore") loadExplore().catch((err) => showToast(err.message));
  if (view === "bookmarks") loadBookmarks().catch((err) => showToast(err.message));
  if (view === "analytics") loadAnalytics().catch((err) => showToast(err.message));
  if (view === "messages") {
    loadConversations().catch((err) => showToast(err.message));
    renderConversationList();
    renderThread();
  }
}

function setupSidebarNav() {
  ["home", "explore", "bookmarks", "analytics", "messages"].forEach((view) => {
    const el = document.getElementById(`nav-${view}`);
    if (el) el.addEventListener("click", () => switchView(view));
  });
}

// ============ EXPLORE ============
async function loadExplore() {
  const { posts: fetched } = await api("/posts/feed?mode=explore");
  exploreData = fetched;
  renderExploreGrid();
}

function renderExploreGrid() {
  const el = document.getElementById("explore-grid");
  if (!el) return;
  const withImages = exploreData.filter((p) => p.image);
  if (withImages.length === 0) {
    el.innerHTML = `<div class="popup-empty">Nothing to discover yet — follow more people or check back later</div>`;
    return;
  }
  el.innerHTML = withImages
    .map(
      (p) => `
    <div class="explore-tile" data-id="${p.id}">
      <img src="${p.image}" alt="${escapeHtml(p.author)}'s post">
      <div class="explore-tile-overlay">
        <span><i class="uil uil-heart"></i> ${p.likes}</span>
        <span><i class="uil uil-comment-dots"></i> ${p.comments}</span>
      </div>
    </div>`
    )
    .join("");

  el.querySelectorAll(".explore-tile").forEach((node) => {
    node.addEventListener("click", () => openExplorePostModal(Number(node.dataset.id)));
  });
}

function openExplorePostModal(id) {
  explorePostModalId = id;
  const post = exploreData.find((p) => p.id === id);
  if (!post) return;
  renderExplorePostModal(post);
  document.getElementById("explore-post-modal").classList.add("show");
}

function renderExplorePostModal(post) {
  const el = document.getElementById("explore-post-modal-content");
  if (!el || explorePostModalId !== post.id) return;
  el.innerHTML = postCardHtml(post);
  wirePostCard(el.querySelector(".post"), post, patchPostEverywhere);
}

function closeExplorePostModal() {
  document.getElementById("explore-post-modal").classList.remove("show");
  explorePostModalId = null;
}

// ============ BOOKMARKS ============
async function loadBookmarks() {
  const { posts: fetched } = await api("/posts/bookmarks");
  bookmarksData = fetched;
  renderBookmarks();
}

function renderBookmarks() {
  const el = document.getElementById("bookmarks-feed");
  if (!el) return;
  if (bookmarksData.length === 0) {
    el.innerHTML = `<div class="popup-empty">No saved posts yet — tap the bookmark icon on any post to save it here</div>`;
    return;
  }
  el.innerHTML = bookmarksData.map(postCardHtml).join("");
  el.querySelectorAll(".post").forEach((node) => {
    const post = bookmarksData.find((p) => p.id === Number(node.dataset.id));
    wirePostCard(node, post, patchPostEverywhere);
  });
}

// ============ ANALYTICS ============
async function loadAnalytics() {
  const stats = await api("/users/me/stats");
  renderAnalytics(stats);
}

function renderAnalytics(stats) {
  const el = document.getElementById("analytics-grid");
  if (!el) return;
  const tiles = [
    { label: "Posts", value: stats.posts, icon: "uil-image" },
    { label: "Likes received", value: stats.likesReceived, icon: "uil-heart" },
    { label: "Comments received", value: stats.commentsReceived, icon: "uil-comment-dots" },
    { label: "Followers", value: stats.followers, icon: "uil-users-alt" },
    { label: "Following", value: stats.following, icon: "uil-user-plus" },
  ];
  el.innerHTML = tiles
    .map(
      (t) => `
    <div class="stat-tile">
      <i class="uil ${t.icon}"></i>
      <span class="stat-value">${t.value}</span>
      <span class="stat-label">${t.label}</span>
    </div>`
    )
    .join("");
}

// ============ CREATE POST ============
function openCreatePostModal() {
  document.getElementById("create-post-avatar").src = CURRENT_USER.avatar;
  document.getElementById("create-post-input").value = "";
  document.getElementById("create-post-file").value = "";
  pendingPostImage = "";
  document.getElementById("create-post-preview").classList.remove("show");
  document.getElementById("create-post-preview-img").src = "";
  document.getElementById("create-post-modal").classList.add("show");
  document.getElementById("create-post-input").focus();
}

function closeCreatePostModal() {
  document.getElementById("create-post-modal").classList.remove("show");
}

async function submitCreatePost() {
  const caption = document.getElementById("create-post-input").value.trim();
  if (!caption && !pendingPostImage) {
    showToast("Write something or add a photo first");
    return;
  }
  try {
    const { post } = await api("/posts", { method: "POST", body: JSON.stringify({ caption, image: pendingPostImage }) });
    closeCreatePostModal();
    if (feedMode === "recent") {
      posts.unshift(post);
      renderFeed();
    } else {
      await loadFeed();
    }
    showToast("Posted!");
  } catch (err) {
    showToast(err.message);
  }
}

// ============ QUOTE MODAL ============
function openQuoteModal(postId) {
  closeAllRepostMenus();
  quotingPostId = postId;
  const original = findPostById(postId);
  document.getElementById("quote-embed-preview").innerHTML = quoteEmbedHtml(original);
  document.getElementById("quote-modal-avatar").src = CURRENT_USER.avatar;
  document.getElementById("quote-input").value = "";
  document.getElementById("quote-char-count").textContent = "280";
  document.getElementById("quote-modal").classList.add("show");
  document.getElementById("quote-input").focus();
}

function closeQuoteModal() {
  document.getElementById("quote-modal").classList.remove("show");
  quotingPostId = null;
}

async function submitQuote() {
  const input = document.getElementById("quote-input");
  const text = input.value.trim();
  if (!text || quotingPostId === null) return;
  try {
    const { post } = await api(`/posts/${quotingPostId}/quote`, {
      method: "POST",
      body: JSON.stringify({ caption: text }),
    });
    posts.unshift(post);
    closeQuoteModal();
    renderFeed();
  } catch (err) {
    showToast(err.message);
  }
}

// ============ SHARE MODAL (shared by posts + snaps) ============
function openShareModal(type, id) {
  closeAllRepostMenus();
  sharingTarget = { type, id };
  renderShareContacts();

  let shareableImage = false;
  if (type === "post") {
    const post = findPostById(id);
    shareableImage = post && (post.image || (post.quoted && post.quoted.image));
  } else {
    const snap = snapsData.find((s) => s.id === id);
    shareableImage = snap && snap.thumb;
  }
  document.getElementById("share-add-story").disabled = !shareableImage;

  document.getElementById("share-modal").classList.add("show");
}

function closeShareModal() {
  document.getElementById("share-modal").classList.remove("show");
  sharingTarget = null;
}

function renderShareContacts() {
  const el = document.getElementById("share-contacts");
  if (conversations.length === 0) {
    el.innerHTML = `<div class="popup-empty">Message someone first to share posts with them</div>`;
    return;
  }
  el.innerHTML = conversations
    .map(
      (m) => `
    <div class="share-contact">
      <div class="profile-photo"><img src="${m.avatar}" alt="${escapeHtml(m.name)}"></div>
      <span class="share-contact-name">${escapeHtml(m.name)}</span>
      <button class="share-send-btn" data-id="${m.id}">Send</button>
    </div>`
    )
    .join("");

  el.querySelectorAll(".share-send-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await sendToContact(Number(btn.dataset.id));
        btn.textContent = "Sent";
        btn.disabled = true;
        btn.classList.add("sent");
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

async function shareRequest(body) {
  const { type, id } = sharingTarget;
  const endpoint = type === "post" ? `/posts/${id}/share` : `/snaps/${id}/share`;
  const data = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
  if (type === "post") patchPostEverywhere(data.post);
  else patchSnap(data.snap);
}

async function sendToContact(contactId) {
  const contact = conversations.find((m) => m.id === contactId);
  await shareRequest({ toUserId: contactId });
  await loadConversations();
  showToast(`Sent to ${contact ? contact.name : "contact"}`);
}

// ============ TOAST ============
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

// ============ STORY VIEWER ============
function buildStoryQueue() {
  const own = storiesData.own.map((item) => ({ own: true, name: "Your Story", avatar: CURRENT_USER.avatar, img: item.img }));
  const friends = [];
  storiesData.tray.forEach((group) => {
    group.stories.forEach((s) => {
      friends.push({ own: false, name: group.name, avatar: group.avatar, img: s.img, storyId: s.id, userId: group.userId });
    });
  });
  return own.concat(friends);
}

function openStory(target) {
  storyQueue = buildStoryQueue();
  let index = 0;
  if (!target.own) {
    index = storyQueue.findIndex((q) => !q.own && q.userId === target.userId);
    if (index === -1) return;
  }
  activeStoryIndex = index;
  document.getElementById("story-viewer").classList.add("show");
  renderStoryProgressBars();
  showStory(activeStoryIndex);
}

function closeStory() {
  document.getElementById("story-viewer").classList.remove("show");
  clearInterval(storyTimer);
  loadStories().catch(() => {});
}

function renderStoryProgressBars() {
  const bars = document.getElementById("story-progress-bars");
  bars.innerHTML = storyQueue.map(() => `<div class="bar"><div class="bar-fill"></div></div>`).join("");
}

function showStory(index) {
  clearInterval(storyTimer);
  const story = storyQueue[index];
  if (!story) return closeStory();

  if (!story.own) {
    api(`/stories/${story.storyId}/view`, { method: "POST" }).catch(() => {});
  }

  document.getElementById("story-viewer-img").src = story.img;
  document.getElementById("story-viewer-avatar").src = story.avatar;
  document.getElementById("story-viewer-name").textContent = story.name;
  document.getElementById("story-viewer-time").textContent = "just now";

  const bars = document.querySelectorAll("#story-progress-bars .bar");
  bars.forEach((bar, i) => {
    bar.classList.toggle("done", i < index);
    const fill = bar.querySelector(".bar-fill");
    fill.style.transition = "none";
    fill.style.width = i < index ? "100%" : "0%";
  });

  const currentFill = bars[index] ? bars[index].querySelector(".bar-fill") : null;
  if (currentFill) {
    requestAnimationFrame(() => {
      currentFill.style.transition = `width ${STORY_DURATION}ms linear`;
      currentFill.style.width = "100%";
    });
  }

  storyTimer = setTimeout(() => nextStory(), STORY_DURATION);
}

function nextStory() {
  if (activeStoryIndex < storyQueue.length - 1) {
    activeStoryIndex++;
    showStory(activeStoryIndex);
  } else {
    closeStory();
  }
}

function prevStory() {
  if (activeStoryIndex > 0) {
    activeStoryIndex--;
    showStory(activeStoryIndex);
  }
}

async function addToMyStory(imgUrl) {
  const story = await api("/stories", { method: "POST", body: JSON.stringify({ image: imgUrl }) });
  storiesData.own.push({ id: story.id, img: story.img, createdAt: story.createdAt });
  renderStories();
  showToast("Added to your story");
}

// ============ MESSAGES ============
// ============ MESSAGES (full page) ============
async function loadConversations() {
  const { conversations: fetched } = await api("/messages/conversations");
  conversations = fetched;
  if (currentView === "messages") renderConversationList();
  updateBadges();
}

function renderConversationList() {
  const el = document.getElementById("messages-page-list");
  if (!el) return;

  const items = conversations.slice().sort((a, b) => Number(b.unread) - Number(a.unread));

  el.innerHTML = items.length
    ? items
        .map(
          (m) => `
    <div class="message-item${m.unread ? " unread" : ""}${openThreadUserId === m.id ? " active" : ""}" data-id="${m.id}">
      <div class="profile-photo"><img src="${m.avatar}" alt="${escapeHtml(m.name)}"></div>
      <div class="message-body">
        <div class="message-name">${escapeHtml(m.name)}${
            m.streak > 0
              ? `<span class="streak${m.streakExpiring ? " expiring" : ""}"><i class="uil uil-fire"></i>${m.streak}</span>`
              : ""
          }</div>
        <div class="message-last">${escapeHtml(m.last)}</div>
      </div>
      <span class="message-time">${m.time}</span>
    </div>`
        )
        .join("")
    : `<div class="popup-empty">No messages yet</div>`;

  el.querySelectorAll(".message-item").forEach((node) => {
    node.addEventListener("click", () => openThread(Number(node.dataset.id)));
  });
}

async function openThread(userId) {
  openThreadUserId = userId;
  renderConversationList();
  const threadEl = document.getElementById("messages-page-thread");
  threadEl.innerHTML = `<div class="popup-empty">Loading...</div>`;
  try {
    const { user, messages } = await api(`/messages/${userId}`);
    threadCache = { user, messages };
    renderThread();
    await loadConversations();
  } catch (err) {
    showToast(err.message);
    openThreadUserId = null;
  }
}

function renderThread() {
  const el = document.getElementById("messages-page-thread");
  if (!el) return;

  if (!threadCache) {
    el.innerHTML = `<div class="popup-empty">Select a conversation to start chatting</div>`;
    return;
  }

  const { user, messages } = threadCache;

  el.innerHTML = `
    <div class="thread-header">
      <div class="profile-photo"><img src="${user.avatar}" alt="${escapeHtml(user.name)}"></div>
      <span class="thread-name">${escapeHtml(user.name)}</span>
    </div>
    <div class="thread-messages" id="thread-messages">
      ${
        messages.length
          ? messages.map((m) => `<div class="thread-bubble${m.mine ? " mine" : ""}">${escapeHtml(m.text)}</div>`).join("")
          : `<div class="popup-empty">Say hello 👋</div>`
      }
    </div>
    <div class="thread-compose">
      <input type="text" id="thread-input" placeholder="Message ${escapeHtml(user.name)}..." maxlength="500">
      <button id="thread-send"><i class="uil uil-message"></i></button>
    </div>`;

  const msgList = el.querySelector("#thread-messages");
  msgList.scrollTop = msgList.scrollHeight;

  const input = el.querySelector("#thread-input");
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      const { message } = await api(`/messages/${user.id}`, { method: "POST", body: JSON.stringify({ text }) });
      threadCache.messages.push(message);
      renderThread();
      loadConversations();
    } catch (err) {
      showToast(err.message);
    }
  };
  el.querySelector("#thread-send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}

// ============ NOTIFICATIONS ============
async function loadNotifications() {
  const { notifications: fetched } = await api("/notifications");
  notifications = fetched;
  renderNotifications();
  updateBadges();
}

function renderNotifications() {
  const el = document.querySelector(".notifications-popup");
  if (!el) return;
  const items = notifications.slice().sort((a, b) => Number(b.unread) - Number(a.unread));

  el.innerHTML =
    `<div class="popup-title">Notifications</div>` +
    (items.length
      ? items
          .map(
            (n) => `
    <div class="notification-item${n.unread ? " unread" : ""}" data-id="${n.id}">
      <div class="notif-icon"><i class="uil ${n.icon}"></i></div>
      <div class="notif-text">${escapeHtml(n.text)}<span class="notif-time">${formatTimeAgo(
              (Date.now() - n.createdAt) / 3600000
            )} ago</span></div>
    </div>`
          )
          .join("")
      : `<div class="popup-empty">You're all caught up</div>`);

  el.querySelectorAll(".notification-item").forEach((node) => {
    node.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(node.dataset.id);
      const n = notifications.find((n) => n.id === id);
      if (n) n.unread = false;
      renderNotifications();
      updateBadges();
      try {
        await api(`/notifications/${id}/read`, { method: "POST" });
      } catch (err) {
        // non-critical
      }
    });
  });
}

// ============ BADGES ============
function updateBadges() {
  const unreadNotifs = notifications.filter((n) => n.unread).length;
  const unreadMsgs = conversations.filter((c) => c.unread).length;

  const notifBadge = document.querySelector("#notifications .notification-count");
  const msgBadge = document.querySelector("#nav-messages .notification-count");

  if (notifBadge) notifBadge.textContent = unreadNotifs > 0 ? unreadNotifs : "";
  if (msgBadge) msgBadge.textContent = unreadMsgs > 0 ? unreadMsgs : "";
}

// ============ SUGGESTIONS (right sidebar) ============
async function loadSuggestions() {
  const { users } = await api("/users/search");
  renderSuggestions(users);
}

function renderSuggestions(users) {
  const el = document.querySelector(".right");
  if (!el) return;
  if (users.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="suggestions">
      <h3>Suggested for you</h3>
      ${users
        .map(
          (u) => `
        <div class="suggestion-item" data-id="${u.id}">
          <div class="profile-photo"><img src="${u.avatar}" alt="${escapeHtml(u.name)}"></div>
          <div class="handle"><h4>${escapeHtml(u.name)}</h4><p class="text-muted">@${escapeHtml(u.handle)}</p></div>
          <button class="btn btn-primary suggestion-follow-btn">Follow</button>
        </div>`
        )
        .join("")}
    </div>`;

  el.querySelectorAll(".suggestion-item").forEach((node) => {
    const btn = node.querySelector(".suggestion-follow-btn");
    btn.addEventListener("click", async () => {
      const id = Number(node.dataset.id);
      try {
        const { following } = await api(`/users/${id}/follow`, { method: "POST" });
        btn.textContent = following ? "Following" : "Follow";
        btn.classList.toggle("following", following);
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

// ============ POPUP TOGGLING ============
function setupPopupToggle(anchorSelector, popupSelector) {
  const anchor = document.querySelector(anchorSelector);
  if (!anchor) return;
  const popup = anchor.querySelector(popupSelector);
  anchor.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = popup.classList.contains("show");
    closeAllPopups();
    if (!isOpen) popup.classList.add("show");
  });
  popup.addEventListener("click", (e) => e.stopPropagation());
}

function closeAllPopups() {
  document
    .querySelectorAll(".notifications-popup.show, .theme-popover.show, .nav-profile-menu.show")
    .forEach((p) => p.classList.remove("show"));
}

function closeAllRepostMenus() {
  document.querySelectorAll(".repost-menu.show").forEach((m) => m.classList.remove("show"));
}

document.addEventListener("click", () => {
  closeAllPopups();
  closeAllRepostMenus();
});

// ============ NAV PROFILE ============
function setupNavProfile() {
  const profile = document.getElementById("nav-profile");
  const menu = document.getElementById("nav-profile-menu");
  profile.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("show");
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch (err) {
      // ignore, redirect regardless
    }
    window.location.href = "login.html";
  });
}

// ============ REALTIME ============
function setupSocket() {
  socket = io();
  socket.on("notification", (n) => {
    notifications.unshift(n);
    renderNotifications();
    updateBadges();
    showToast(n.text);
  });
  socket.on("message", (m) => {
    if (currentView === "messages" && openThreadUserId === m.senderId && threadCache) {
      threadCache.messages.push({ ...m, mine: false });
      renderThread();
    } else {
      showToast("New message");
    }
    loadConversations().catch(() => {});
  });
}

// ============ THEME ============
const THEMES = [
  { id: "light", name: "Light", color: "#1877f2" },
  { id: "dark", name: "Dark", color: "#242526" },
  { id: "sunset", name: "Sunset", color: "#ee2a7b" },
  { id: "ocean", name: "Ocean", color: "#0ea5a4" },
  { id: "forest", name: "Forest", color: "#2e7d32" },
];

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function renderThemePopover() {
  const el = document.querySelector(".theme-popover");
  if (!el) return;
  el.innerHTML =
    `<div class="popup-title">Theme</div>` +
    THEMES.map(
      (t) => `
    <div class="theme-swatch-item${CURRENT_USER.theme === t.id ? " active" : ""}" data-theme="${t.id}">
      <span class="theme-swatch" style="background:${t.color}"></span>
      <span>${t.name}</span>
      ${CURRENT_USER.theme === t.id ? '<i class="uil uil-check"></i>' : ""}
    </div>`
    ).join("");

  el.querySelectorAll(".theme-swatch-item").forEach((node) => {
    node.addEventListener("click", async (e) => {
      e.stopPropagation();
      const theme = node.dataset.theme;
      applyTheme(theme);
      CURRENT_USER.theme = theme;
      renderThemePopover();
      try {
        await api("/settings/theme", { method: "POST", body: JSON.stringify({ theme }) });
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

// ============ SETTINGS ============
function openSettingsModal() {
  document.getElementById("settings-name").textContent = CURRENT_USER.name;
  document.getElementById("settings-handle").textContent = `@${CURRENT_USER.handle}`;
  document.getElementById("settings-email").textContent = CURRENT_USER.email;
  document.getElementById("settings-current-password").value = "";
  document.getElementById("settings-new-password").value = "";
  document.getElementById("settings-confirm-password").value = "";
  document.getElementById("settings-error").textContent = "";
  document.getElementById("settings-modal").classList.add("show");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("show");
}

async function submitPasswordChange() {
  const errorEl = document.getElementById("settings-error");
  errorEl.textContent = "";
  const currentPassword = document.getElementById("settings-current-password").value;
  const newPassword = document.getElementById("settings-new-password").value;
  const confirmPassword = document.getElementById("settings-confirm-password").value;

  if (newPassword !== confirmPassword) {
    errorEl.textContent = "New passwords don't match";
    return;
  }

  try {
    await api("/settings/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
    showToast("Password updated");
    closeSettingsModal();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ============ INIT ============
function showBackendUnreachableBanner() {
  const banner = document.getElementById("backend-warning");
  if (banner) banner.classList.add("show");
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const { user } = await api("/auth/me");
    CURRENT_USER = user;
  } catch (err) {
    if (err.backendUnreachable) showBackendUnreachableBanner();
    return;
  }

  applyTheme(CURRENT_USER.theme || "light");
  document.getElementById("nav-profile-photo").src = CURRENT_USER.avatar;
  document.getElementById("sidebar-profile-photo").src = CURRENT_USER.avatar;
  document.getElementById("sidebar-profile-name").textContent = CURRENT_USER.name;
  document.getElementById("sidebar-profile-handle").textContent = `@${CURRENT_USER.handle}`;

  setupSocket();
  setupNavProfile();
  setupFeedTabs();
  setupSidebarNav();
  setupPopupToggle("#notifications", ".notifications-popup");
  setupPopupToggle("#theme", ".theme-popover");
  renderThemePopover();

  await Promise.all([
    loadFeed().catch((err) => showToast(err.message)),
    loadStories().catch((err) => showToast(err.message)),
    loadSnaps().catch((err) => showToast(err.message)),
    loadNotifications().catch((err) => showToast(err.message)),
    loadConversations().catch((err) => showToast(err.message)),
    loadSuggestions().catch(() => {}),
  ]);

  document.getElementById("story-close").addEventListener("click", closeStory);
  document.getElementById("story-next").addEventListener("click", nextStory);
  document.getElementById("story-prev").addEventListener("click", prevStory);
  document.getElementById("story-viewer").addEventListener("click", (e) => {
    if (e.target.id === "story-viewer") closeStory();
  });

  document.getElementById("snap-viewer-close").addEventListener("click", closeSnapViewer);
  document.getElementById("snap-next").addEventListener("click", nextSnap);
  document.getElementById("snap-prev").addEventListener("click", prevSnap);
  document.getElementById("snap-viewer").addEventListener("click", (e) => {
    if (e.target.id === "snap-viewer") closeSnapViewer();
  });

  document.getElementById("story-upload-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file);
      await addToMyStory(url);
    } catch (err) {
      showToast(err.message);
    }
    e.target.value = "";
  });

  document.getElementById("open-create-post").addEventListener("click", openCreatePostModal);
  document.getElementById("open-create-post-sidebar").addEventListener("click", openCreatePostModal);
  document.getElementById("create-post-close").addEventListener("click", closeCreatePostModal);
  document.getElementById("create-post-modal").addEventListener("click", (e) => {
    if (e.target.id === "create-post-modal") closeCreatePostModal();
  });
  document.getElementById("create-post-submit").addEventListener("click", submitCreatePost);
  document.getElementById("create-post-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file);
      pendingPostImage = url;
      document.getElementById("create-post-preview-img").src = url;
      document.getElementById("create-post-preview").classList.add("show");
    } catch (err) {
      showToast(err.message);
    }
  });
  document.getElementById("create-post-preview-remove").addEventListener("click", () => {
    pendingPostImage = "";
    document.getElementById("create-post-file").value = "";
    document.getElementById("create-post-preview").classList.remove("show");
  });

  document.getElementById("quote-close").addEventListener("click", closeQuoteModal);
  document.getElementById("quote-submit").addEventListener("click", submitQuote);
  document.getElementById("quote-modal").addEventListener("click", (e) => {
    if (e.target.id === "quote-modal") closeQuoteModal();
  });
  document.getElementById("quote-input").addEventListener("input", (e) => {
    document.getElementById("quote-char-count").textContent = 280 - e.target.value.length;
  });

  document.getElementById("share-close").addEventListener("click", closeShareModal);
  document.getElementById("share-modal").addEventListener("click", (e) => {
    if (e.target.id === "share-modal") closeShareModal();
  });
  document.getElementById("share-copy-link").addEventListener("click", async () => {
    if (!sharingTarget) return;
    const url = `${window.location.origin}/${sharingTarget.type}/${sharingTarget.id}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
    try {
      await shareRequest({});
      showToast("Link copied to clipboard");
    } catch (err) {
      showToast(err.message);
    }
  });
  document.getElementById("share-add-story").addEventListener("click", async (e) => {
    if (e.currentTarget.disabled || !sharingTarget) return;
    let img = null;
    if (sharingTarget.type === "post") {
      const post = findPostById(sharingTarget.id);
      img = post && (post.image || (post.quoted && post.quoted.image));
    } else {
      const snap = snapsData.find((s) => s.id === sharingTarget.id);
      img = snap && snap.thumb;
    }
    if (!img) return;
    try {
      await addToMyStory(img);
      await shareRequest({});
      closeShareModal();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("explore-post-modal-close").addEventListener("click", closeExplorePostModal);
  document.getElementById("explore-post-modal").addEventListener("click", (e) => {
    if (e.target.id === "explore-post-modal") closeExplorePostModal();
  });

  document.getElementById("open-settings").addEventListener("click", openSettingsModal);
  document.getElementById("settings-close").addEventListener("click", closeSettingsModal);
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettingsModal();
  });
  document.getElementById("settings-password-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitPasswordChange();
  });
});
