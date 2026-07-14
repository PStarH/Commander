(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- Chart 1: TypeScript Security Benchmark Scores ---
  var chart1 = echarts.init(document.getElementById('chart-ts-security'), null, { renderer: 'svg' });
  chart1.setOption({
    animation: false,
    grid: { left: '3%', right: '8%', bottom: '3%', top: '3%', containLabel: true },
    xAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { formatter: '{value}', color: muted },
      splitLine: { lineStyle: { color: rule } },
      axisLine: { lineStyle: { color: rule } }
    },
    yAxis: {
      type: 'category',
      data: ['HarmBench', 'CyberSecEval', 'InjecAgent', 'AssEBench', 'AgentHarm', 'AgentSafetyBench', 'AgentDojo'],
      axisLabel: { color: ink },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 49, itemStyle: { color: '#a16207' } },
        { value: 91, itemStyle: { color: accent2 } },
        { value: 98, itemStyle: { color: accent2 } },
        { value: 100, itemStyle: { color: accent } },
        { value: 100, itemStyle: { color: accent } },
        { value: 100, itemStyle: { color: accent } },
        { value: 100, itemStyle: { color: accent } }
      ],
      barWidth: '60%',
      label: {
        show: true,
        position: 'right',
        formatter: '{c}',
        color: ink,
        fontWeight: 700
      }
    }]
  });
  window.addEventListener('resize', function() { chart1.resize(); });

  // --- Chart 2: AgentDojo Baseline vs Commander ---
  var chart2 = echarts.init(document.getElementById('chart-agentdojo'), null, { renderer: 'svg' });
  var suites = ['workspace', 'banking', 'slack', 'travel'];
  var baselineUtility = [100, 80, 100, 100];
  var commanderUtility = [80, 80, 80, 100];
  var baselineSecurity = [100, 70, 92, 90];
  var commanderSecurity = [100, 100, 100, 100];
  var baselineAsr = [0, 30, 8, 10];
  var commanderAsr = [0, 0, 0, 0];

  chart2.setOption({
    animation: false,
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      axisPointer: { type: 'shadow' }
    },
    legend: {
      data: ['Baseline Utility', 'Commander Utility', 'Baseline Security', 'Commander Security', 'Baseline ASR', 'Commander ASR'],
      bottom: 0,
      textStyle: { color: ink }
    },
    grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: suites,
      axisLabel: { color: ink },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 110,
      axisLabel: { formatter: '{value}%', color: muted },
      splitLine: { lineStyle: { color: rule } },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [
      { name: 'Baseline Utility', type: 'bar', data: baselineUtility, itemStyle: { color: bg2, borderColor: accent2, borderWidth: 1 }, barGap: '0%', barCategoryGap: '25%' },
      { name: 'Commander Utility', type: 'bar', data: commanderUtility, itemStyle: { color: accent2 } },
      { name: 'Baseline Security', type: 'bar', data: baselineSecurity, itemStyle: { color: bg2, borderColor: accent, borderWidth: 1 } },
      { name: 'Commander Security', type: 'bar', data: commanderSecurity, itemStyle: { color: accent } },
      { name: 'Baseline ASR', type: 'bar', data: baselineAsr, itemStyle: { color: '#fca5a5' } },
      { name: 'Commander ASR', type: 'bar', data: commanderAsr, itemStyle: { color: '#15803d' } }
    ]
  });
  window.addEventListener('resize', function() { chart2.resize(); });
})();
