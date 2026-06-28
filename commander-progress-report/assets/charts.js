(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var ok = style.getPropertyValue('--ok').trim();
  var bad = style.getPropertyValue('--bad').trim();

  // --- Chart 1: Weekly commits (git log --date=format:%G-W%V) ---
  var c1 = echarts.init(document.getElementById('chart-commits'), null, { renderer: 'svg' });
  c1.setOption({
    animation: false,
    grid: { left: 48, right: 24, top: 24, bottom: 44 },
    tooltip: { trigger: 'axis', appendToBody: true, formatter: function (p) { return p[0].name + '：' + p[0].value + ' 次提交'; } },
    xAxis: {
      type: 'category',
      data: ['W20\n5/12', 'W21\n5/19', 'W22\n5/26', 'W23\n6/2', 'W24\n6/9', 'W25\n6/15', 'W26\n6/22'],
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 10, lineHeight: 13, fontFamily: 'GeistMono, monospace' }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLabel: { color: muted, fontFamily: 'GeistMono, monospace', fontSize: 10 }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 57, itemStyle: { color: accent } },
        { value: 16, itemStyle: { color: accent } },
        { value: 54, itemStyle: { color: accent } },
        { value: 0, itemStyle: { color: rule } },
        { value: 0, itemStyle: { color: rule } },
        { value: 49, itemStyle: { color: accent } },
        { value: 186, itemStyle: { color: accent2 } }
      ],
      barWidth: '52%',
      label: {
        show: true,
        position: 'top',
        color: ink,
        fontFamily: 'GeistMono, monospace',
        fontSize: 11,
        fontWeight: 700,
        formatter: function (p) { return p.value > 0 ? p.value : ''; }
      }
    }]
  });
  window.addEventListener('resize', function () { c1.resize(); });

  // --- Chart 2: Module wiring status (grep -rn import tracing) ---
  var c2 = echarts.init(document.getElementById('chart-wiring'), null, { renderer: 'svg' });
  c2.setOption({
    animation: false,
    grid: { left: 100, right: 40, top: 16, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      axisPointer: { type: 'shadow' },
      formatter: function (p) {
        var name = p[0].name;
        var val = p[0].value;
        var status = val > 0 ? '已接线（' + val + ' 处外部导入）' : '休眠（0 处外部导入）';
        return name + '：' + status;
      }
    },
    xAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLabel: { color: muted, fontFamily: 'GeistMono, monospace', fontSize: 10 }
    },
    yAxis: {
      type: 'category',
      data: [
        'distributedEventBus',
        'contractTeeEnclave',
        'riskAssessor',
        'hnswIndex',
        'petriNetScheduler',
        'dlqRetryWorker',
        'memoryWriteGuard',
        'taintTracker',
        'gdprCompliance',
        'supervisionTree',
        'EntSecurityGateway'
      ],
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: {
        color: ink,
        fontSize: 10,
        fontFamily: 'GeistMono, monospace',
        fontWeight: 700,
        formatter: function (val) {
          return val.length > 18 ? val.substring(0, 17) + '…' : val;
        }
      }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 0, itemStyle: { color: bad } },
        { value: 0, itemStyle: { color: bad } },
        { value: 0, itemStyle: { color: bad } },
        { value: 1, itemStyle: { color: ok } },
        { value: 1, itemStyle: { color: ok } },
        { value: 1, itemStyle: { color: ok } },
        { value: 1, itemStyle: { color: ok } },
        { value: 1, itemStyle: { color: ok } },
        { value: 2, itemStyle: { color: ok } },
        { value: 2, itemStyle: { color: ok } },
        { value: 7, itemStyle: { color: ok } }
      ],
      barWidth: '56%',
      label: {
        show: true,
        position: 'right',
        color: ink,
        fontFamily: 'GeistMono, monospace',
        fontSize: 11,
        fontWeight: 700,
        formatter: function (p) { return p.value > 0 ? p.value : '0'; }
      }
    }]
  });
  window.addEventListener('resize', function () { c2.resize(); });
})();
