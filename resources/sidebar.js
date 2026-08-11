const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const stockTooltip = document.getElementById('stock-tooltip');
const savedState = vscode.getState() || {};
const collapsed = new Set(savedState.collapsed || []);
let latestPayload = { state: 'loading', groups: [] };
let draggedCode = '';
let draggedCategory = '';
let tooltipTimer;
let tooltipRow;
let tooltipX = 0;
let tooltipY = 0;

const pinOffSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" d="M5.1 1.8h5.8l-.9 4 2.2 2.1v1H8.7v4.5L8 14.5l-.7-1.1V8.9H3.8v-1L6 5.8l-.9-4z"/><path d="M2.3 2.3l11.4 11.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const pinOnSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1.5h6l-1 4.2 2.4 2.2v1.3H8.8v4.2L8 14.7l-.8-1.3V9.2H3.6V7.9L6 5.7 5 1.5z"/></svg>';
const deleteSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const dragSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3h2v2H5V3zm4 0h2v2H9V3zM5 7h2v2H5V7zm4 0h2v2H9V7zm-4 4h2v2H5v-2zm4 0h2v2H9v-2z"/></svg>';
const chevronSvg = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.25 4.25L6 8l3.75-3.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function trendSymbol(trend) {
  if (trend === 'rise') return '↑';
  if (trend === 'fall') return '↓';
  if (trend === 'error') return '!';
  return '−';
}

function clearDropMarkers() {
  document.querySelectorAll('.drop-before,.drop-after').forEach(row => {
    row.classList.remove('drop-before', 'drop-after');
  });
}

function positionTooltip(x, y) {
  const gap = 10;
  const bounds = stockTooltip.getBoundingClientRect();
  let left = x + gap;
  let top = y + gap;
  if (left + bounds.width > window.innerWidth - 6) left = x - bounds.width - gap;
  if (top + bounds.height > window.innerHeight - 6) top = y - bounds.height - gap;
  stockTooltip.style.left = Math.max(6, left) + 'px';
  stockTooltip.style.top = Math.max(6, top) + 'px';
}

function getRowTrend(row) {
  const trendElement = row.querySelector('.trend');
  if (trendElement?.classList.contains('rise')) return 'rise';
  if (trendElement?.classList.contains('fall')) return 'fall';
  return 'flat';
}

function appendDayRange(row) {
  if (!row?.dataset.range) return;
  let range;
  try { range = JSON.parse(row.dataset.range); } catch { return; }
  if (!range || !Number.isFinite(range.position)) return;

  const container = document.createElement('div');
  container.className = 'tooltip-day-range ' + getRowTrend(row);
  container.setAttribute('aria-label', '日内价格位置');

  const labels = document.createElement('div');
  labels.className = 'tooltip-range-labels';
  const low = document.createElement('span');
  low.textContent = '低 ';
  const lowPrice = document.createElement('span');
  lowPrice.className = 'tooltip-range-price';
  lowPrice.textContent = range.low;
  low.appendChild(lowPrice);
  const current = document.createElement('span');
  current.className = 'current';
  current.textContent = '现 ';
  const currentPrice = document.createElement('span');
  currentPrice.className = 'tooltip-range-price';
  currentPrice.textContent = range.current;
  current.appendChild(currentPrice);
  const high = document.createElement('span');
  high.className = 'high';
  high.textContent = '高 ';
  const highPrice = document.createElement('span');
  highPrice.className = 'tooltip-range-price';
  highPrice.textContent = range.high;
  high.appendChild(highPrice);
  labels.append(low, current, high);

  const track = document.createElement('div');
  track.className = 'tooltip-range-track';
  const fill = document.createElement('div');
  fill.className = 'tooltip-range-fill';
  fill.style.width = range.position + '%';
  const marker = document.createElement('div');
  marker.className = 'tooltip-range-marker';
  marker.style.left = range.position + '%';
  track.append(fill, marker);

  const caption = document.createElement('div');
  caption.className = 'tooltip-range-caption';
  caption.textContent = range.flat
    ? '暂无日内振幅'
    : '日内位置 ' + Math.round(range.position) + '%';
  container.append(labels, track, caption);
  stockTooltip.appendChild(container);
}

function showStockTooltip(row, x, y) {
  if (!row?.dataset.tooltip) return;
  tooltipRow = row;
  tooltipX = x;
  tooltipY = y;
  stockTooltip.replaceChildren();
  let codeValue = row.dataset.code || '';
  let timeValue = '';
  const trend = getRowTrend(row);

  row.dataset.tooltip.split('\n').forEach((line, index) => {
    if (index === 0) {
      const header = document.createElement('div');
      header.className = 'tooltip-header';
      const title = document.createElement('span');
      title.className = 'tooltip-title';
      const match = line.match(/^(.*)（([^（）]+)）$/);
      title.textContent = match ? match[1] : line;
      if (match) codeValue = match[2];
      header.appendChild(title);
      const current = document.createElement('span');
      current.className = 'tooltip-current ' + trend;
      current.textContent = row.querySelector('.current-price')?.textContent || '—';
      header.appendChild(current);
      stockTooltip.appendChild(header);
      return;
    }
    if (line === '---') {
      const divider = document.createElement('div');
      divider.className = 'tooltip-divider';
      stockTooltip.appendChild(divider);
      return;
    }
    const tabIndex = line.indexOf('\t');
    if (tabIndex >= 0) {
      const labelText = line.slice(0, tabIndex);
      const valueText = line.slice(tabIndex + 1);
      if (labelText === '时间') {
        timeValue = valueText;
        return;
      }
      const item = document.createElement('div');
      item.className = 'tooltip-row';
      const label = document.createElement('span');
      label.className = 'tooltip-label';
      label.textContent = labelText;
      const value = document.createElement('span');
      value.className = 'tooltip-value';
      value.textContent = valueText;
      item.append(label, value);
      if (labelText === '涨跌') {
        item.classList.add('tooltip-change', trend);
        stockTooltip.appendChild(item);
      } else if (labelText === '阶段') {
        item.classList.add('tooltip-session');
        stockTooltip.appendChild(item);
      } else if (labelText === '溢价') {
        item.classList.add('tooltip-premium');
        stockTooltip.appendChild(item);
      } else {
        stockTooltip.appendChild(item);
      }
      return;
    }
    const message = document.createElement('div');
    message.className = 'tooltip-message';
    message.textContent = line;
    stockTooltip.appendChild(message);
  });
  appendDayRange(row);
  if (codeValue || timeValue) {
    const footer = document.createElement('div');
    footer.className = 'tooltip-row tooltip-footer';
    const code = document.createElement('span');
    code.className = 'tooltip-code';
    code.textContent = codeValue;
    const time = document.createElement('span');
    time.textContent = timeValue;
    footer.append(code, time);
    stockTooltip.appendChild(footer);
  }
  stockTooltip.hidden = false;
  positionTooltip(x, y);
}

function scheduleStockTooltip(row, x, y) {
  if (tooltipTimer) clearTimeout(tooltipTimer);
  tooltipRow = row;
  tooltipX = x;
  tooltipY = y;
  tooltipTimer = setTimeout(() => {
    tooltipTimer = undefined;
    if (tooltipRow === row) showStockTooltip(row, tooltipX, tooltipY);
  }, 90);
}

function hideStockTooltip(row) {
  if (row && tooltipRow !== row) return;
  if (tooltipTimer) clearTimeout(tooltipTimer);
  tooltipTimer = undefined;
  tooltipRow = undefined;
  stockTooltip.hidden = true;
}

function bindInteractions() {
  document.querySelectorAll('.group-header').forEach(header => {
    header.addEventListener('click', () => {
      const category = header.dataset.category;
      collapsed.has(category) ? collapsed.delete(category) : collapsed.add(category);
      vscode.setState({ collapsed: Array.from(collapsed) });
      render();
    });
  });
  document.querySelectorAll('.pin-button').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      vscode.postMessage({ type: 'togglePin', code: button.dataset.code });
    });
  });
  document.querySelectorAll('.delete-button').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      vscode.postMessage({ type: 'remove', code: button.dataset.code });
    });
  });
  document.querySelectorAll('.price').forEach(button => {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'precision', code: button.dataset.code });
    });
  });
  document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('dragstart', event => {
      draggedCode = handle.dataset.code;
      draggedCategory = handle.dataset.category;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCode);
    });
    handle.addEventListener('dragend', () => {
      draggedCode = '';
      draggedCategory = '';
      clearDropMarkers();
    });
  });
  document.querySelectorAll('.ticker-row').forEach(row => {
    row.addEventListener('pointerenter', event => {
      scheduleStockTooltip(row, event.clientX, event.clientY);
    });
    row.addEventListener('pointermove', event => {
      tooltipX = event.clientX;
      tooltipY = event.clientY;
      if (!stockTooltip.hidden && tooltipRow === row) positionTooltip(tooltipX, tooltipY);
    });
    row.addEventListener('pointerleave', () => hideStockTooltip(row));
    row.addEventListener('focusin', () => {
      const bounds = row.getBoundingClientRect();
      showStockTooltip(row, bounds.left + Math.min(bounds.width / 2, 120), bounds.bottom);
    });
    row.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!row.contains(document.activeElement)) hideStockTooltip(row);
      }, 0);
    });
    row.addEventListener('dragover', event => {
      if (!draggedCode || draggedCode === row.dataset.code || draggedCategory !== row.dataset.category) return;
      event.preventDefault();
      clearDropMarkers();
      const bounds = row.getBoundingClientRect();
      row.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'drop-before' : 'drop-after');
    });
    row.addEventListener('drop', event => {
      if (!draggedCode || draggedCode === row.dataset.code || draggedCategory !== row.dataset.category) return;
      event.preventDefault();
      const bounds = row.getBoundingClientRect();
      vscode.postMessage({
        type: 'move',
        code: draggedCode,
        targetCode: row.dataset.code,
        position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
      });
      clearDropMarkers();
    });
  });
}

function updateExistingRows(payload) {
  if (payload.state !== 'ready' || payload.message) return false;

  const sections = Array.from(app.querySelectorAll(':scope > .group'));
  if (sections.length !== payload.groups.length) return false;

  let visibleTooltipNeedsUpdate = false;
  for (let groupIndex = 0; groupIndex < payload.groups.length; groupIndex++) {
    const group = payload.groups[groupIndex];
    const section = sections[groupIndex];
    const header = section.querySelector('.group-header');
    const rows = Array.from(section.querySelectorAll('.ticker-row'));
    if (header?.dataset.category !== group.category || rows.length !== group.items.length) {
      return false;
    }
    if (rows.some((row, index) => row.dataset.code !== group.items[index].code)) {
      return false;
    }

    section.classList.toggle('collapsed', collapsed.has(group.category));
    const groupLabel = section.querySelector('.group-label');
    if (groupLabel) groupLabel.textContent = group.label;

    for (let itemIndex = 0; itemIndex < group.items.length; itemIndex++) {
      const item = group.items[itemIndex];
      const row = rows[itemIndex];
      const nextRange = item.dayRange ? JSON.stringify(item.dayRange) : '';
      const tooltipChanged = row.dataset.tooltip !== item.tooltip || row.dataset.range !== nextRange;
      row.dataset.tooltip = item.tooltip;
      row.dataset.range = nextRange;

      const trend = row.querySelector('.trend');
      if (trend) {
        trend.className = 'trend ' + item.trend;
        trend.textContent = trendSymbol(item.trend);
      }

      const nameText = row.querySelector('.name-text');
      if (nameText) nameText.textContent = item.name;
      const name = row.querySelector('.name');
      const existingDelayBadge = row.querySelector('.delay-badge');
      if (item.delayed && !existingDelayBadge && name) {
        const delayBadge = document.createElement('span');
        delayBadge.className = 'delay-badge';
        delayBadge.title = '延迟行情（通常至少延迟约 15 分钟）';
        delayBadge.textContent = 'D';
        name.appendChild(delayBadge);
      } else if (!item.delayed && existingDelayBadge) {
        existingDelayBadge.remove();
      }

      const currentPrice = row.querySelector('.current-price');
      if (currentPrice) currentPrice.textContent = item.price;
      const percent = row.querySelector('.percent');
      if (percent) {
        percent.className = 'percent ' + item.trend;
        percent.textContent = item.percent ? '(' + item.percent + ')' : '';
      }

      const pinButton = row.querySelector('.pin-button');
      if (pinButton) {
        pinButton.classList.toggle('pinned', item.pinned);
        pinButton.title = item.pinned
          ? '状态栏：已显示（点击移除）'
          : '状态栏：未显示（点击固定）';
        pinButton.setAttribute('aria-pressed', String(item.pinned));
        pinButton.innerHTML = item.pinned ? pinOnSvg : pinOffSvg;
      }

      if (tooltipChanged && tooltipRow === row && !stockTooltip.hidden) {
        visibleTooltipNeedsUpdate = true;
      }
    }
  }

  if (visibleTooltipNeedsUpdate && tooltipRow) {
    showStockTooltip(tooltipRow, tooltipX, tooltipY);
  }
  return true;
}

function render() {
  const payload = latestPayload;
  if (updateExistingRows(payload)) return;

  hideStockTooltip();
  if (payload.state === 'loading') {
    app.innerHTML = '<div class="state">正在获取行情数据…</div>';
    return;
  }
  if (payload.state === 'error' && payload.groups.length === 0) {
    app.innerHTML = '<div class="notice">' + escapeHtml(payload.message || '行情刷新失败') + '</div>';
    return;
  }
  let html = payload.message ? '<div class="notice">' + escapeHtml(payload.message) + '</div>' : '';
  if (payload.groups.length === 0) {
    app.innerHTML = html + '<div class="state">还没有监控标的，请点击顶部 + 添加。</div>';
    return;
  }
  for (const group of payload.groups) {
    const isCollapsed = collapsed.has(group.category);
    html += '<section class="group' + (isCollapsed ? ' collapsed' : '') + '">';
    html += '<button class="group-header" data-category="' + escapeHtml(group.category) + '"><span class="chevron">' + chevronSvg + '</span><span class="group-label">' + escapeHtml(group.label) + '</span></button>';
    html += '<div class="group-items">';
    for (const item of group.items) {
      const code = escapeHtml(item.code);
      html += '<div class="ticker-row" tabindex="0" aria-describedby="stock-tooltip" data-code="' + code + '" data-category="' + escapeHtml(group.category) + '" data-tooltip="' + escapeHtml(item.tooltip) + '" data-range="' + escapeHtml(item.dayRange ? JSON.stringify(item.dayRange) : '') + '">';
      html += '<span class="trend ' + item.trend + '">' + trendSymbol(item.trend) + '</span>';
      html += '<span class="name"><span class="name-text">' + escapeHtml(item.name) + '</span>' + (item.delayed ? '<span class="delay-badge" title="延迟行情（通常至少延迟约 15 分钟）">D</span>' : '') + '</span>';
      html += '<button class="price" data-code="' + code + '" title="设置小数位数"><span class="current-price">' + escapeHtml(item.price) + '</span><span class="percent ' + item.trend + '">' + (item.percent ? '(' + escapeHtml(item.percent) + ')' : '') + '</span></button>';
      html += '<button class="icon-button pin-button' + (item.pinned ? ' pinned' : '') + '" data-code="' + code + '" title="' + (item.pinned ? '状态栏：已显示（点击移除）' : '状态栏：未显示（点击固定）') + '" aria-label="切换状态栏显示" aria-pressed="' + item.pinned + '">' + (item.pinned ? pinOnSvg : pinOffSvg) + '</button>';
      html += '<span class="drag-handle" draggable="true" data-code="' + code + '" data-category="' + escapeHtml(group.category) + '" title="按住并拖动排序" role="button" aria-label="拖动排序">' + dragSvg + '</span>';
      html += '<button class="delete-button" data-code="' + code + '" title="从自选移除" aria-label="从自选移除">' + deleteSvg + '</button>';
      html += '</div>';
    }
    html += '</div></section>';
  }
  app.innerHTML = html;
  bindInteractions();
}

window.addEventListener('message', event => {
  if (event.data?.type === 'render') {
    latestPayload = event.data.payload;
    render();
  }
});

bindInteractions();
vscode.postMessage({ type: 'ready' });
