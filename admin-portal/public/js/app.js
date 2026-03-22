/**
 * HR Admin Portal — Frontend Application
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getAuthToken() {
  return localStorage.getItem("hr_admin_token") || "";
}

function authHeaders() {
  const token = getAuthToken();
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiFetch(url, options = {}) {
  const headers = { ...authHeaders(), ...options.headers };
  // Don't set Content-Type for FormData
  if (options.body instanceof FormData) {
    delete headers["Content-Type"];
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const token = prompt("请输入管理员令牌 (OPENCLAW_WEB_AUTH_TOKEN):");
    if (token) {
      localStorage.setItem("hr_admin_token", token);
      return apiFetch(url, options);
    }
    throw new Error("未授权");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const navLinks = document.querySelectorAll(".nav-tabs a");
const pages = document.querySelectorAll(".page");

function switchPage(pageName) {
  navLinks.forEach((a) => a.classList.toggle("active", a.dataset.page === pageName));
  pages.forEach((p) => p.classList.toggle("active", p.id === `page-${pageName}`));

  if (pageName === "documents") {
    void loadDocuments();
  }
  if (pageName === "audit-log") {
    void loadAuditLog();
  }
}

navLinks.forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    switchPage(a.dataset.page);
    history.replaceState(null, "", `#${a.dataset.page}`);
  });
});

// Handle initial hash
const initialPage = location.hash.replace("#", "") || "upload";
switchPage(initialPage);

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const uploadZone = document.getElementById("upload-zone");
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview");
const fileName = document.getElementById("file-name");
const fileSize = document.getElementById("file-size");
const removeFile = document.getElementById("remove-file");
const uploadBtn = document.getElementById("upload-btn");
const uploadProgress = document.getElementById("upload-progress");
const progressFill = document.getElementById("progress-fill");
const uploadResult = document.getElementById("upload-result");

let selectedFile = null;

uploadZone.addEventListener("click", () => fileInput.click());

uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("dragover");
});

uploadZone.addEventListener("dragleave", () => {
  uploadZone.classList.remove("dragover");
});

uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) {
    setFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    setFile(fileInput.files[0]);
  }
});

removeFile.addEventListener("click", () => clearFile());

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  filePreview.classList.add("active");
  uploadZone.style.display = "none";
  uploadBtn.disabled = false;
  uploadResult.className = "upload-result";
  uploadResult.style.display = "none";
}

function clearFile() {
  selectedFile = null;
  fileInput.value = "";
  filePreview.classList.remove("active");
  uploadZone.style.display = "";
  uploadBtn.disabled = true;
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

uploadBtn.addEventListener("click", async () => {
  if (!selectedFile) {
    return;
  }

  const formData = new FormData();
  formData.append("file", selectedFile);
  formData.append("category", document.getElementById("upload-category").value);
  formData.append("doc_id", document.getElementById("upload-doc-id").value);
  formData.append("version", document.getElementById("upload-version").value);
  formData.append("effective_date", document.getElementById("upload-date").value);

  uploadBtn.disabled = true;
  uploadProgress.classList.add("active");
  progressFill.style.width = "30%";

  try {
    const res = await apiFetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    progressFill.style.width = "100%";
    const data = await res.json();

    if (data.success) {
      uploadResult.className = "upload-result success";
      let html = `文档上传成功！<br>`;
      html += `文件: ${data.file} | 分类: ${data.category} | 来源格式: ${data.source_format}<br>`;
      html += `存储路径: ${data.path}`;
      if (data.warnings && data.warnings.length > 0) {
        html += `<br><br><strong>警告:</strong><br>`;
        html += data.warnings.map((w) => `- ${w}`).join("<br>");
      }
      uploadResult.innerHTML = html;
    } else {
      uploadResult.className = "upload-result error";
      uploadResult.textContent = `上传失败: ${data.error}`;
    }
  } catch (err) {
    uploadResult.className = "upload-result error";
    uploadResult.textContent = `上传失败: ${err.message}`;
  } finally {
    setTimeout(() => {
      uploadProgress.classList.remove("active");
      progressFill.style.width = "0%";
    }, 500);
    clearFile();
  }
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

let allDocuments = [];

async function loadDocuments() {
  try {
    const res = await apiFetch("/api/documents");
    const data = await res.json();
    allDocuments = data.documents || [];
    renderDocuments();
  } catch (err) {
    console.error("Failed to load documents:", err);
  }
}

function renderDocuments() {
  const tbody = document.getElementById("docs-table-body");
  const empty = document.getElementById("docs-empty");
  const filterCat = document.getElementById("doc-filter-category").value;
  const search = document.getElementById("doc-search").value.toLowerCase();

  let filtered = allDocuments;
  if (filterCat) {
    filtered = filtered.filter((d) => d.category === filterCat);
  }
  if (search) {
    filtered = filtered.filter(
      (d) => d.file.toLowerCase().includes(search) || d.doc_id.toLowerCase().includes(search),
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";
  tbody.innerHTML = filtered
    .map(
      (d) => `<tr>
      <td>${esc(d.file)}</td>
      <td>${esc(d.doc_id) || "-"}</td>
      <td>${esc(d.version) || "-"}</td>
      <td><span class="badge badge-category">${esc(d.category)}</span></td>
      <td>${esc(d.effective_date) || "-"}</td>
      <td>${esc(d.source_format) || "-"}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="viewDoc('${esc(d.category)}','${esc(d.file)}')">查看</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDelete('${esc(d.category)}','${esc(d.file)}','${esc(d.doc_id)}')">删除</button>
      </td>
    </tr>`,
    )
    .join("");
}

document.getElementById("doc-filter-category").addEventListener("change", renderDocuments);
document.getElementById("doc-search").addEventListener("input", renderDocuments);
document.getElementById("refresh-docs").addEventListener("click", () => {
  void loadDocuments();
});

// View document (open in new tab as plain text)
window.viewDoc = async function (category, file) {
  try {
    const res = await apiFetch(`/api/documents/${category}/${file}`);
    const data = await res.json();
    const win = window.open("", "_blank");
    win.document.write(
      `<pre style="white-space:pre-wrap;font-family:monospace;padding:20px;">${esc(data.content)}</pre>`,
    );
    win.document.title = file;
  } catch (err) {
    alert("加载文档失败: " + err.message);
  }
};

// Delete document
let deleteTarget = null;

window.confirmDelete = function (category, file, docId) {
  deleteTarget = { category, file };
  document.getElementById("delete-modal-text").textContent =
    `确定要删除文档 "${file}"${docId ? ` (${docId})` : ""} 吗？此操作不可撤销。`;
  document.getElementById("delete-modal").classList.add("active");
};

document.getElementById("delete-cancel").addEventListener("click", () => {
  document.getElementById("delete-modal").classList.remove("active");
  deleteTarget = null;
});

document.getElementById("delete-confirm").addEventListener("click", async () => {
  if (!deleteTarget) {
    return;
  }
  try {
    await apiFetch(`/api/documents/${deleteTarget.category}/${deleteTarget.file}`, {
      method: "DELETE",
    });
    document.getElementById("delete-modal").classList.remove("active");
    deleteTarget = null;
    void loadDocuments();
  } catch (err) {
    alert("删除失败: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

let auditPage = 1;

async function loadAuditLog() {
  try {
    const params = new URLSearchParams();
    const action = document.getElementById("audit-filter-action").value;
    const docId = document.getElementById("audit-filter-doc-id").value;
    const from = document.getElementById("audit-filter-from").value;
    const to = document.getElementById("audit-filter-to").value;

    if (action) {
      params.set("action", action);
    }
    if (docId) {
      params.set("doc_id", docId);
    }
    if (from) {
      params.set("from", from);
    }
    if (to) {
      params.set("to", to);
    }
    params.set("page", auditPage);
    params.set("page_size", 50);

    const token = getAuthToken();
    if (token) {
      params.set("token", token);
    }

    const res = await fetch(`/api/audit-log?${params}`);
    if (res.status === 401) {
      const t = prompt("请输入管理员令牌 (OPENCLAW_WEB_AUTH_TOKEN):");
      if (t) {
        localStorage.setItem("hr_admin_token", t);
        void loadAuditLog();
      }
      return;
    }

    const data = await res.json();
    renderAuditLog(data);
  } catch (err) {
    console.error("Failed to load audit log:", err);
  }
}

function renderAuditLog(data) {
  const tbody = document.getElementById("audit-table-body");
  const empty = document.getElementById("audit-empty");
  const pagination = document.getElementById("audit-pagination");
  const logs = data.logs || [];

  if (logs.length === 0) {
    tbody.innerHTML = "";
    empty.style.display = "";
    pagination.innerHTML = "";
    return;
  }

  empty.style.display = "none";

  const actionBadge = (action) => {
    const cls =
      {
        UPLOAD: "badge-upload",
        DELETE: "badge-delete",
        UPDATE: "badge-update",
        CREATE_CATEGORY: "badge-category",
      }[action] || "";
    const label =
      { UPLOAD: "上传", DELETE: "删除", UPDATE: "更新", CREATE_CATEGORY: "新增分类" }[action] ||
      action;
    return `<span class="badge ${cls}">${label}</span>`;
  };

  tbody.innerHTML = logs
    .map(
      (l) => `<tr>
      <td>${formatTime(l.timestamp)}</td>
      <td>${actionBadge(l.action)}</td>
      <td>${esc(l.file)}</td>
      <td>${esc(l.details?.doc_id || "")}</td>
      <td>${esc(l.details?.version || "")}</td>
      <td>${esc(l.details?.category || "")}</td>
      <td>${esc(l.details?.reason || l.details?.source_format || "")}</td>
    </tr>`,
    )
    .join("");

  // Pagination
  const totalPages = Math.ceil(data.total / data.page_size);
  if (totalPages > 1) {
    let html = "";
    if (data.page > 1) {
      html += `<button class="btn btn-outline btn-sm" onclick="gotoAuditPage(${data.page - 1})">上一页</button>`;
    }
    html += `<span>第 ${data.page} / ${totalPages} 页 (共 ${data.total} 条)</span>`;
    if (data.page < totalPages) {
      html += `<button class="btn btn-outline btn-sm" onclick="gotoAuditPage(${data.page + 1})">下一页</button>`;
    }
    pagination.innerHTML = html;
  } else {
    pagination.innerHTML = data.total > 0 ? `<span>共 ${data.total} 条记录</span>` : "";
  }
}

window.gotoAuditPage = function (page) {
  auditPage = page;
  void loadAuditLog();
};

document.getElementById("audit-filter-apply").addEventListener("click", () => {
  auditPage = 1;
  void loadAuditLog();
});

// Export CSV
document.getElementById("export-audit").addEventListener("click", () => {
  const params = new URLSearchParams();
  const action = document.getElementById("audit-filter-action").value;
  const docId = document.getElementById("audit-filter-doc-id").value;
  const from = document.getElementById("audit-filter-from").value;
  const to = document.getElementById("audit-filter-to").value;

  if (action) {
    params.set("action", action);
  }
  if (docId) {
    params.set("doc_id", docId);
  }
  if (from) {
    params.set("from", from);
  }
  if (to) {
    params.set("to", to);
  }

  const token = getAuthToken();
  if (token) {
    params.set("token", token);
  }

  window.open(`/api/audit-log/export?${params}`, "_blank");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  if (!str) {
    return "";
  }
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
