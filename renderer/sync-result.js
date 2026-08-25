"use strict";

// === 同步结果窗口逻辑 ===

const $ = (id) => document.getElementById(id);

// 接收主进程传来的同步结果数据
window.api.onSyncResultData((data) => {
  renderResult(data);
});

function renderResult(data) {
  const summary = data.summary || "";
  const detail = data.detail || "";
  const detailCount = data.detailCount || 0;

  // 渲染摘要文字
  const summaryEl = $("result-summary");

  // 解析摘要中的关键数字
  const numbers = {};
  const patterns = [
    { key: "total", re: /总项数：(\d+)/ },
    { key: "success", re: /成功：(\d+)/ },
    { key: "failed", re: /失败：(\d+)/ },
    { key: "skipped", re: /已跳过：(\d+)/ },
    { key: "pending", re: /未执行：(\d+)/ },
  ];
  patterns.forEach((p) => {
    const m = summary.match(p.re);
    if (m) numbers[p.key] = parseInt(m[1], 10);
  });

  // 构建卡片式摘要
  let cardsHtml = "";
  if (numbers.total != null) {
    cardsHtml += `<div class="summary-item"><span class="summary-label">总项数</span><span class="summary-value">${numbers.total}</span></div>`;
  }
  if (numbers.success != null) {
    cardsHtml += `<div class="summary-item"><span class="summary-label">成功</span><span class="summary-value success">${numbers.success}</span></div>`;
  }
  if (numbers.failed != null) {
    cardsHtml += `<div class="summary-item"><span class="summary-label">失败</span><span class="summary-value failed">${numbers.failed}</span></div>`;
  }
  if (numbers.skipped != null) {
    cardsHtml += `<div class="summary-item"><span class="summary-label">已跳过</span><span class="summary-value skipped">${numbers.skipped}</span></div>`;
  }
  if (numbers.pending != null) {
    cardsHtml += `<div class="summary-item"><span class="summary-label">未执行</span><span class="summary-value pending">${numbers.pending}</span></div>`;
  }
  cardsHtml += `<div class="summary-item"><span class="summary-label">用时</span><span class="summary-value" style="font-size:14px">${summary.match(/总用时：(.+?)(?:\s|$)/)?.[1] || "—"}</span></div>`;

  summaryEl.innerHTML = `<div class="summary-card">${cardsHtml}</div>`;

  // 渲染详情
  const detailEl = $("result-detail");
  if (detail && detail.trim()) {
    detailEl.textContent = detail;
  } else {
    detailEl.innerHTML = '<div class="detail-empty">没有失败或跳过的项目，全部同步成功。</div>';
  }
}

// --- Buttons ---
$("btnClose").addEventListener("click", () => window.close());
$("btnOk").addEventListener("click", () => window.close());

$("btnCopy").addEventListener("click", async () => {
  const summary = $("result-summary").textContent || "";
  const detail = $("result-detail").textContent || "";
  const text = summary + "\n\n" + detail;
  try {
    await navigator.clipboard.writeText(text);
    $("btnCopy").textContent = "已复制";
    setTimeout(() => { $("btnCopy").textContent = "复制结果"; }, 2000);
  } catch (err) {
    alert("复制失败：" + (err.message || err));
  }
});
