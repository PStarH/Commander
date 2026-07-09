(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var passColor = '#166534';
  var failColor = '#991b1b';
  var warnColor = '#a16207';

  function initChart(id, option) {
    var el = document.getElementById(id);
    if (!el) return;
    var chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption(option);
    window.addEventListener('resize', function() { chart.resize(); });
  }

  // Chart 1: Security benchmark block rates
  initChart('chart-security', {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: { type: 'category', data: ['AgentDojo', 'AgentSafetyBench', 'AgentHarm', 'InjecAgent', 'Red Team'], axisLine: { lineStyle: { color: rule } }, axisLabel: { color: ink } },
    yAxis: { type: 'value', max: 100, axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: rule } } },
    series: [{
      name: '拦截/通过率',
      type: 'bar',
      data: [
        { value: 100, itemStyle: { color: passColor } },
        { value: 100, itemStyle: { color: passColor } },
        { value: 100, itemStyle: { color: passColor } },
        { value: 100, itemStyle: { color: passColor } },
        { value: 100, itemStyle: { color: passColor } }
      ],
      barWidth: '50%',
      label: { show: true, position: 'top', formatter: '{c}%', color: ink, fontWeight: 600 }
    }]
  });

  // Chart 2: Chaos dimension scores
  initChart('chart-chaos-dim', {
    animation: false,
    tooltip: { trigger: 'axis', appendToBody: true },
    radar: {
      indicator: [
        { name: 'reasoning', max: 100 },
        { name: 'runtime', max: 100 },
        { name: 'recovery', max: 100 },
        { name: 'integrity', max: 100 }
      ],
      axisName: { color: ink, fontWeight: 600 },
      splitArea: { areaStyle: { color: [bg2, '#ffffff'] } },
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'radar',
      data: [{ value: [79, 71.6, 68.7, 85.9], name: 'Dimension Scores', areaStyle: { color: accent + '33' }, lineStyle: { color: accent, width: 2 }, itemStyle: { color: accent } }]
    }]
  });

  // Chart 3: Chaos capability scores
  initChart('chart-chaos-cap', {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true, formatter: function(p) { return p[0].name + '<br/>' + p[0].marker + ' ' + p[0].value.toFixed(2); } },
    grid: { left: '3%', right: '8%', bottom: '3%', top: '5%', containLabel: true },
    xAxis: { type: 'value', max: 100, axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
    yAxis: { type: 'category', data: ['retry_with_backoff', 'circuit_breaking', 'timeout_handling', 'distributed_locking', 'schema_detection', 'dlq', 'distributed_transaction', 'rollback', 'data_isolation', 'idempotency'].reverse(), axisLine: { lineStyle: { color: rule } }, axisLabel: { color: ink } },
    series: [{
      name: '能力得分',
      type: 'bar',
      data: [68.01, 68.68, 68.9, 70.47, 69.03, 74.34, 77.29, 74.61, 79.81, 85.56].reverse(),
      barWidth: '60%',
      itemStyle: { color: accent },
      label: { show: true, position: 'right', formatter: function(p) { return p.value.toFixed(2); }, color: ink, fontWeight: 600 }
    }]
  });

  // Chart 4: E2E latency & RPS
  initChart('chart-e2e', {
    animation: false,
    tooltip: { trigger: 'axis', appendToBody: true },
    legend: { data: ['P50', 'P95', 'P99', 'RPS'], textStyle: { color: ink }, bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '12%', top: '10%', containLabel: true },
    xAxis: { type: 'category', data: ['C=1', 'C=5', 'C=10', 'C=20', 'C=50'], axisLine: { lineStyle: { color: rule } }, axisLabel: { color: ink } },
    yAxis: [
      { type: 'value', name: 'Latency (ms)', max: 30, axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
      { type: 'value', name: 'RPS', axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted }, splitLine: { show: false } }
    ],
    series: [
      { name: 'P50', type: 'line', data: [12, 13, 13, 11, 12], lineStyle: { color: accent }, itemStyle: { color: accent }, symbol: 'circle' },
      { name: 'P95', type: 'line', data: [20, 19, 19, 19, 19], lineStyle: { color: accent2 }, itemStyle: { color: accent2 }, symbol: 'circle' },
      { name: 'P99', type: 'line', data: [20, 20, 20, 19, 19], lineStyle: { color: warnColor }, itemStyle: { color: warnColor }, symbol: 'circle' },
      { name: 'RPS', type: 'line', yAxisIndex: 1, data: [82, 292, 535, 1047, 2597], lineStyle: { color: passColor, type: 'dashed' }, itemStyle: { color: passColor }, symbol: 'diamond' }
    ]
  });
})();
