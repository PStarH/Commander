(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var green = style.getPropertyValue('--green').trim();
  var yellow = style.getPropertyValue('--yellow').trim();
  var red = style.getPropertyValue('--red').trim();

  // --- Chart 1: Radar — 8 Dimension Acquisition Readiness ---
  var chartRadar = echarts.init(document.getElementById('chart-radar'), null, { renderer: 'svg' });
  chartRadar.setOption({
    animation: false,
    tooltip: { appendToBody: true },
    legend: {
      data: ['当前评分', '5000万目标'],
      bottom: 0,
      textStyle: { color: muted, fontSize: 12 }
    },
    radar: {
      indicator: [
        { name: '技术深度\n(15%)', max: 10 },
        { name: '安全合规\n(15%)', max: 10 },
        { name: '差异化护城河\n(10%)', max: 10 },
        { name: '架构成熟度\n(15%)', max: 10 },
        { name: '生产就绪度\n(15%)', max: 10 },
        { name: '可维护性\n(10%)', max: 10 },
        { name: '团队与人才\n(10%)', max: 10 },
        { name: '市场验证\n(10%)', max: 10 }
      ],
      center: ['50%', '52%'],
      radius: '68%',
      splitNumber: 5,
      axisName: {
        color: ink,
        fontSize: 11,
        fontWeight: 600
      },
      splitLine: { lineStyle: { color: rule } },
      splitArea: { areaStyle: { color: [bg2, 'transparent'] } },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'radar',
      data: [
        {
          value: [8.0, 7.0, 6.5, 3.5, 4.0, 4.5, 2.0, 1.0],
          name: '当前评分',
          itemStyle: { color: accent },
          lineStyle: { color: accent, width: 2 },
          areaStyle: { color: accent, opacity: 0.08 },
          symbol: 'rect',
          symbolSize: 6
        },
        {
          value: [7.0, 7.0, 7.0, 6.5, 7.0, 6.5, 6.0, 6.0],
          name: '5000万目标',
          itemStyle: { color: green },
          lineStyle: { color: green, width: 2, type: 'dashed' },
          areaStyle: { color: green, opacity: 0.05 },
          symbol: 'circle',
          symbolSize: 5
        }
      ]
    }]
  });
  window.addEventListener('resize', function() { chartRadar.resize(); });

  // --- Chart 2: Valuation Journey Bar Chart ---
  var chartVal = echarts.init(document.getElementById('chart-valuation'), null, { renderer: 'svg' });
  chartVal.setOption({
    animation: false,
    tooltip: {
      appendToBody: true,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: function(params) {
        var p = params[0];
        return p.name + '<br/>估值区间: <strong>' + p.value + '</strong> 万 RMB';
      }
    },
    grid: { left: '12%', right: '8%', top: '10%', bottom: '15%' },
    xAxis: {
      type: 'category',
      data: ['当前状态', '+团队3人', '+首个付费客户', '+架构50分', '+SOC2 Type I', '5000万目标'],
      axisLabel: { color: ink, fontSize: 11, interval: 0, rotate: 15 },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '万 RMB',
      nameTextStyle: { color: muted, fontSize: 11 },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { lineStyle: { color: rule } },
      axisLine: { show: false }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 2750, itemStyle: { color: red } },
        { value: 3500, itemStyle: { color: yellow } },
        { value: 4500, itemStyle: { color: yellow } },
        { value: 5000, itemStyle: { color: green } },
        { value: 5500, itemStyle: { color: green } },
        { value: 5000, itemStyle: { color: accent } }
      ],
      barWidth: '50%',
      label: {
        show: true,
        position: 'top',
        color: ink,
        fontSize: 12,
        fontWeight: 700,
        formatter: '{c}'
      }
    }]
  });
  window.addEventListener('resize', function() { chartVal.resize(); });

  // --- Chart 3: Timeline Milestone vs Valuation ---
  var chartTimeline = echarts.init(document.getElementById('chart-timeline'), null, { renderer: 'svg' });
  chartTimeline.setOption({
    animation: false,
    tooltip: { appendToBody: true, trigger: 'axis' },
    legend: {
      data: ['估值下限', '估值上限'],
      bottom: 0,
      textStyle: { color: muted, fontSize: 12 }
    },
    grid: { left: '12%', right: '8%', top: '10%', bottom: '15%' },
    xAxis: {
      type: 'category',
      data: ['Day 0\n当前', 'Day 30\n架构门槛关闭', 'Day 60\n首客户+团队', 'Day 90\n估值锚定'],
      axisLabel: { color: ink, fontSize: 11, interval: 0 },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '万 RMB',
      nameTextStyle: { color: muted, fontSize: 11 },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { lineStyle: { color: rule } },
      axisLine: { show: false },
      min: 0,
      max: 6000
    },
    series: [
      {
        name: '估值下限',
        type: 'line',
        data: [2000, 2800, 3800, 4500],
        itemStyle: { color: accent2 },
        lineStyle: { color: accent2, width: 2 },
        symbol: 'rect',
        symbolSize: 8,
        areaStyle: { color: accent2, opacity: 0.06 }
      },
      {
        name: '估值上限',
        type: 'line',
        data: [3500, 4200, 5200, 5800],
        itemStyle: { color: green },
        lineStyle: { color: green, width: 2 },
        symbol: 'circle',
        symbolSize: 8,
        areaStyle: { color: green, opacity: 0.06 }
      }
    ]
  });
  window.addEventListener('resize', function() { chartTimeline.resize(); });

})();
