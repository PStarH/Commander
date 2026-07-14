(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- Chart: Capability Radar ---
  var radarChart = echarts.init(document.getElementById('chart-radar'), null, { renderer: 'svg' });
  radarChart.setOption({
    animation: false,
    tooltip: { trigger: 'item', appendToBody: true },
    legend: {
      data: ['Commander 现状', '业界最优解'],
      bottom: 0,
      textStyle: { color: ink }
    },
    radar: {
      indicator: [
        { name: '分层架构', max: 5 },
        { name: '记忆管理', max: 5 },
        { name: '检索召回', max: 5 },
        { name: '评测体系', max: 5 },
        { name: '安全防御', max: 5 },
        { name: '工程实现', max: 5 }
      ],
      shape: 'polygon',
      splitNumber: 5,
      axisName: { color: ink, fontWeight: 600 },
      splitLine: { lineStyle: { color: rule } },
      splitArea: { areaStyle: { color: [bg2, '#ffffff'] } },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      name: '能力对比',
      type: 'radar',
      data: [
        {
          value: [4.0, 2.5, 3.5, 2.0, 4.0, 2.5],
          name: 'Commander 现状',
          areaStyle: { color: accent + '33' },
          lineStyle: { color: accent, width: 2 },
          itemStyle: { color: accent }
        },
        {
          value: [4.5, 4.5, 4.5, 4.5, 4.5, 4.5],
          name: '业界最优解',
          areaStyle: { color: accent2 + '22' },
          lineStyle: { color: accent2, width: 2, type: 'dashed' },
          itemStyle: { color: accent2 }
        }
      ]
    }]
  });
  window.addEventListener('resize', function() { radarChart.resize(); });

  // --- Chart: Priority Matrix ---
  var matrixChart = echarts.init(document.getElementById('chart-matrix'), null, { renderer: 'svg' });
  var improvements = [
    { name: '统一 MemoryStore 抽象', impact: 4.5, cost: 2.5, phase: 'P0' },
    { name: '补齐 TTL Curator', impact: 4.0, cost: 2.0, phase: 'P0' },
    { name: '标准化 API 输出', impact: 4.0, cost: 2.5, phase: 'P0' },
    { name: '建立 Memory Benchmark', impact: 4.5, cost: 3.0, phase: 'P0' },
    { name: '记忆管理 Agent', impact: 5.0, cost: 4.5, phase: 'P1' },
    { name: '增强语义记忆/时序图谱', impact: 4.5, cost: 4.0, phase: 'P1' },
    { name: '多路融合重排序', impact: 3.5, cost: 3.0, phase: 'P1' },
    { name: '用户审查接口', impact: 4.0, cost: 3.0, phase: 'P1' },
    { name: '可插拔向量后端', impact: 3.5, cost: 4.0, phase: 'P2' },
    { name: '记忆可观测性', impact: 3.0, cost: 3.0, phase: 'P2' },
    { name: '对抗性测试套件', impact: 3.5, cost: 3.5, phase: 'P2' }
  ];

  var seriesData = improvements.map(function(item) {
    return {
      name: item.name,
      value: [item.cost, item.impact],
      phase: item.phase
    };
  });

  matrixChart.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      formatter: function(params) {
        return params.data.phase + '<br/>' + params.data.name + '<br/>影响: ' + params.value[1] + ' / 成本: ' + params.value[0];
      }
    },
    grid: { left: '8%', right: '12%', top: '12%', bottom: '12%' },
    xAxis: {
      name: '实施成本（1=低，5=高）',
      nameLocation: 'middle',
      nameGap: 30,
      min: 1,
      max: 5,
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted },
      nameTextStyle: { color: ink }
    },
    yAxis: {
      name: '业务影响（1=低，5=高）',
      nameLocation: 'middle',
      nameGap: 40,
      min: 1,
      max: 5,
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted },
      nameTextStyle: { color: ink }
    },
    series: [{
      type: 'scatter',
      symbolSize: function(data) {
        return 16 + (data[1] - 1) * 6;
      },
      data: seriesData,
      itemStyle: {
        color: function(params) {
          var phase = params.data.phase;
          if (phase === 'P0') return accent;
          if (phase === 'P1') return accent2;
          return muted;
        },
        opacity: 0.85
      },
      label: {
        show: true,
        formatter: function(params) {
          return params.data.phase + ' ' + params.data.name;
        },
        position: 'right',
        fontSize: 11,
        color: ink
      },
      markLine: {
        silent: true,
        lineStyle: { color: rule, type: 'solid' },
        data: [
          { xAxis: 3.25, label: { formatter: '成本阈值', color: muted } },
          { yAxis: 3.75, label: { formatter: '影响阈值', color: muted } }
        ]
      },
      markArea: {
        silent: true,
        itemStyle: { color: accent + '0a' },
        data: [[{
          xAxis: 1,
          yAxis: 5
        }, {
          xAxis: 3.25,
          yAxis: 3.75
        }]]
      }
    }]
  });
  window.addEventListener('resize', function() { matrixChart.resize(); });
})();
