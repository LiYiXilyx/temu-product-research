const elements = {
  activeProducts: document.querySelector('#activeProducts'),
  pending: document.querySelector('#pending'),
  completed: document.querySelector('#completed'),
  failed: document.querySelector('#failed'),
  unavailable: document.querySelector('#unavailable'),
  reviews: document.querySelector('#reviews'),
  notice: document.querySelector('#notice'),
  lastRefresh: document.querySelector('#lastRefresh'),
  taskLabel: document.querySelector('#taskLabel'),
  taskBadge: document.querySelector('#taskBadge'),
  taskStep: document.querySelector('#taskStep'),
  currentProduct: document.querySelector('#currentProduct'),
  batchSummary: document.querySelector('#batchSummary'),
  progressBar: document.querySelector('#progressBar'),
  manualGate: document.querySelector('#manualGate'),
  continueButton: document.querySelector('#continueButton'),
  logs: document.querySelector('#logs'),
  openExcel: document.querySelector('#openExcel'),
  openFolder: document.querySelector('#openFolder'),
  clearLog: document.querySelector('#clearLog'),
  clearExcel: document.querySelector('#clearExcel'),
  batchSize: document.querySelector('#batchSize'),
  pauseButton: document.querySelector('#pauseButton'),
  resumeButton: document.querySelector('#resumeButton'),
  openBrowser: document.querySelector('#openBrowser'),
  browserPulse: document.querySelector('#browserPulse'),
  browserStatus: document.querySelector('#browserStatus'),
  toast: document.querySelector('#toast')
};

const taskButtons = [...document.querySelectorAll('[data-task]')];
let lastTaskId = null;
let clearedTaskId = null;
let toastTimer = null;

function number(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function dateTime(value) {
  if (!value) return '商品池尚未成功采集';
  return `最近采集：${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))}`;
}

function showToast(message, duration = 2600) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败。');
  return result;
}

function renderNotice(payload) {
  const { task, data, browserReady } = payload;
  elements.notice.className = 'notice';
  if (task.waitingForInput) {
    elements.notice.textContent = '任务正在等待人工处理：确认采集 Chrome 已正常显示当前商品详情和评论后，再点击右侧“继续执行”。';
    elements.notice.classList.add('show');
  } else if (task.status === 'failed') {
    elements.notice.textContent = '上一次任务没有完成。请查看运行记录；原商品池和已抓数据不会被清空。';
    elements.notice.classList.add('show', 'error');
  } else if (task.status === 'paused') {
    elements.notice.textContent = '批次已暂停，数据库断点已保留；点击右侧“继续批次”会优先恢复未完成商品。';
    elements.notice.classList.add('show');
  } else if (task.status === 'partial') {
    elements.notice.textContent = '批次已结束，但成功数未达到验收阈值；待处理商品可使用“重试失败”继续。';
    elements.notice.classList.add('show');
  } else if (task.status === 'completed') {
    elements.notice.textContent = task.kind === 'clear'
      ? '运营 Excel 内容已清除；数据库中的商品和评论仍然保留。'
      : '任务已完成，数据库和运营 Excel 已更新。';
    elements.notice.classList.add('show', 'success');
  } else if (!browserReady) {
    elements.notice.textContent = '先点击“打开采集 Chrome”，人工进入 Temu 德国站摩托配件并选择 Top Sales；程序只读取你准备好的当前页面。';
    elements.notice.classList.add('show');
  } else if (!data.catalogReady) {
    elements.notice.textContent = '采集 Chrome 已连接。请准备好摩托配件 Top Sales 页面，再运行“采集当前页面”。';
    elements.notice.classList.add('show');
  }
}

function renderLogs(task) {
  if (clearedTaskId === task.id || task.logs.length === 0) {
    elements.logs.innerHTML = '<p class="empty-log">任务日志会显示在这里。</p>';
    return;
  }
  const wasNearBottom = elements.logs.scrollHeight - elements.logs.scrollTop - elements.logs.clientHeight < 60;
  elements.logs.replaceChildren(...task.logs.map(log => {
    const line = document.createElement('p');
    line.className = log.source;
    line.textContent = log.text;
    return line;
  }));
  if (wasNearBottom || lastTaskId !== task.id) elements.logs.scrollTop = elements.logs.scrollHeight;
}

function render(payload) {
  const { data, task, excelExists, browserReady, reviewEngine } = payload;
  elements.activeProducts.textContent = number(data.activeProducts);
  elements.pending.textContent = number(data.pending + data.inProgress);
  elements.completed.textContent = number(data.completed);
  elements.failed.textContent = number(data.failed);
  elements.unavailable.textContent = number(data.unavailable);
  elements.reviews.textContent = number(data.reviews);
  elements.lastRefresh.textContent = dateTime(data.lastCatalogRefresh);
  elements.taskLabel.textContent = task.label;
  elements.taskStep.textContent = task.step || '请选择左侧操作开始';

  const labels = { idle: '空闲', running: task.waitingForInput ? '等待验证' : '运行中', paused: '已暂停', completed: '验收通过', partial: '部分完成', failed: '失败' };
  elements.taskBadge.textContent = labels[task.status] || task.status;
  elements.taskBadge.className = `status-badge ${task.status}`;
  elements.progressBar.className = task.status;
  const progressPercent = task.batchProgress?.total
    ? Math.min(100, Math.max(3, task.batchProgress.current / task.batchProgress.total * 100))
    : (['completed', 'partial'].includes(task.status) ? 100 : task.status === 'running' ? 12 : 0);
  elements.progressBar.style.width = `${progressPercent}%`;
  elements.manualGate.hidden = !task.waitingForInput;
  elements.currentProduct.hidden = !task.currentProduct;
  elements.currentProduct.textContent = task.currentProduct ? `当前商品：${task.currentProduct}` : '';
  const summary = task.batchSummary;
  elements.batchSummary.hidden = !summary;
  elements.batchSummary.textContent = summary
    ? `结果：成功 ${summary.completed || 0} · 无评论 ${summary.noReviews || 0} · 确认售罄 ${summary.confirmedSoldOut || 0} · 待重试 ${summary.deferred || 0} · 失败 ${summary.failed || 0}`
    : '';
  elements.openExcel.disabled = !excelExists;
  const engineLabel = reviewEngine === 'operator-review-v3' ? ' · 评论引擎 V3' : '';
  elements.browserStatus.textContent = browserReady ? `采集 Chrome 已连接${engineLabel}` : '采集 Chrome 未连接';
  elements.browserPulse.classList.toggle('offline', !browserReady);
  elements.openBrowser.textContent = browserReady ? '采集 Chrome 已打开' : '打开采集 Chrome';

  const running = task.status === 'running';
  const batchKinds = ['reviews-light', 'reviews-deep', 'retry'];
  for (const button of taskButtons) {
    const needsCatalog = ['current-review', ...batchKinds].includes(button.dataset.task);
    const needsBrowser = ['capture', 'current-review', ...batchKinds].includes(button.dataset.task);
    button.disabled = running || (needsCatalog && !data.catalogReady) || (needsBrowser && !browserReady);
  }
  elements.batchSize.disabled = running;
  elements.pauseButton.hidden = !(running && batchKinds.includes(task.kind));
  elements.resumeButton.hidden = task.status !== 'paused';
  elements.openBrowser.disabled = running || browserReady;
  elements.clearExcel.disabled = running || !excelExists;
  renderNotice(payload);
  renderLogs(task);
  lastTaskId = task.id;
}

async function refresh() {
  try {
    render(await api('/api/status'));
  } catch (error) {
    elements.notice.textContent = `运营台连接异常：${error.message}`;
    elements.notice.className = 'notice show error';
  }
}

for (const button of taskButtons) {
  button.addEventListener('click', async () => {
    try {
      clearedTaskId = null;
      const isBatch = ['reviews-light', 'reviews-deep', 'retry'].includes(button.dataset.task);
      await api(`/api/tasks/${button.dataset.task}`, {
        method: 'POST',
        body: isBatch ? { batchSize: Number(elements.batchSize.value) } : undefined
      });
      showToast('任务已开始');
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  });
}

elements.continueButton.addEventListener('click', async () => {
  try {
    await api('/api/tasks/continue', { method: 'POST' });
    showToast('已继续执行');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

elements.pauseButton.addEventListener('click', async () => {
  try {
    await api('/api/tasks/pause', { method: 'POST' });
    showToast('正在暂停，数据库断点会保留');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

elements.resumeButton.addEventListener('click', async () => {
  try {
    await api('/api/tasks/resume', { method: 'POST' });
    showToast('已从断点继续批次');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

elements.openBrowser.addEventListener('click', async () => {
  try {
    showToast('正在打开采集 Chrome…');
    await api('/api/browser/open', { method: 'POST' });
    showToast('采集 Chrome 已打开，请人工准备 Top Sales 页面');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

elements.openExcel.addEventListener('click', async () => {
  try {
    const result = await api('/api/open/excel', { method: 'POST' });
    showToast(result.message || '正在打开运营 Excel…');
  }
  catch (error) { showToast(error.message, 8000); }
});
elements.openFolder.addEventListener('click', async () => {
  try {
    const result = await api('/api/open/folder', { method: 'POST' });
    showToast(result.message || '正在打开结果文件夹…');
  }
  catch (error) { showToast(error.message, 8000); }
});
elements.clearExcel.addEventListener('click', async () => {
  const confirmed = window.confirm('确认清除运营 Excel 中的商品、主图和评论内容吗？\n\n数据库不会删除，之后点击“重新导出”即可恢复。');
  if (!confirmed) {
    showToast('已取消清除');
    return;
  }
  try {
    clearedTaskId = null;
    await api('/api/tasks/clear', { method: 'POST', body: { confirmed: true } });
    showToast('正在清除 Excel 内容…');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});
elements.clearLog.addEventListener('click', () => {
  clearedTaskId = lastTaskId;
  elements.logs.innerHTML = '<p class="empty-log">当前显示已清空，不影响后台任务记录。</p>';
});

await refresh();
setInterval(refresh, 1000);
