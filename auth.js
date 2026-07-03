function showBackendUnreachableBanner() {
  const banner = document.getElementById("backend-warning");
  if (banner) banner.classList.add("show");
}

// Wraps fetch + JSON parsing so a response from the wrong server (e.g. a static
// file server's 404 HTML page instead of our API) is reported clearly instead of
// surfacing a confusing "Unexpected token <" JSON parse error.
async function apiRequest(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (networkErr) {
    showBackendUnreachableBanner();
    throw new Error("Can't reach the LovyApp server. See the notice above.");
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    showBackendUnreachableBanner();
    throw new Error("Can't reach the LovyApp server. See the notice above.");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

document.addEventListener("DOMContentLoaded", () => {
  fetch("/api/auth/me", { credentials: "include" })
    .then((res) => {
      if (res.ok) {
        window.location.href = "index.html";
        return;
      }
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) showBackendUnreachableBanner();
    })
    .catch(() => showBackendUnreachableBanner());

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isLogin = tab.dataset.form === "login";
      document.getElementById("login-form").style.display = isLogin ? "flex" : "none";
      document.getElementById("register-form").style.display = isLogin ? "none" : "flex";
    });
  });

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    try {
      await apiRequest("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      window.location.href = "index.html";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("register-error");
    errorEl.textContent = "";
    const name = document.getElementById("register-name").value.trim();
    const handle = document.getElementById("register-handle").value.trim();
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;

    try {
      await apiRequest("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, handle, email, password }),
      });
      window.location.href = "index.html";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
});
