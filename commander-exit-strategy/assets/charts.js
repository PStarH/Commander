(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- Chart 1: Market Size Growth ---
  var chart1 = echarts.init(document.getElementById('chart-market-size'), null, { renderer: 'svg' });
  chart1.setOption({
    animation: false,
    tooltip: { appendToBody: true, trigger: 'axis' },
    grid: { left: 60, right: 30, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['2024', '2025', '2026E', '2027E', '2028E'],
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 12 }
    },
    yAxis: {
      type: 'value',
      name: '亿美元',
      nameTextStyle: { color: muted, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted, fontSize: 12 }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 28, itemStyle: { color: bg2 } },
        { value: 59, itemStyle: { color: accent2 + '99' } },
        { value: 187, itemStyle: { color: accent } },
        { value: 420, itemStyle: { color: accent } },
        { value: 780, itemStyle: { color: accent } }
      ],
      barWidth: '50%',
      label: {
        show: true,
        position: 'top',
        color: ink,
        fontSize: 12,
        fontWeight: 600,
        formatter: function(p) { return '$' + p.value + '亿'; }
      }
    }]
  });
  window.addEventListener('resize', function() { chart1.resize(); });

  // --- Chart 2: Exit Paths Comparison ---
  var chart2 = echarts.init(document.getElementById('chart-exit-paths'), null, { renderer: 'svg' });
  chart2.setOption({
    animation: false,
    tooltip: { appendToBody: true, trigger: 'axis' },
    grid: { left: 120, right: 30, top: 20, bottom: 40 },
    xAxis: {
      type: 'value',
      name: 'ARR 门槛 ($M)',
      nameTextStyle: { color: muted, fontSize: 11 },
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted, fontSize: 12 }
    },
    yAxis: {
      type: 'category',
      data: ['人才收购', '战略收购', 'IPO'],
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 13, fontWeight: 600 }
    },
    series: [
      {
        type: 'bar',
        name: '最低 ARR',
        data: [
          { value: 0, itemStyle: { color: accent2 + '66' } },
          { value: 2.5, itemStyle: { color: accent } },
          { value: 100, itemStyle: { color: accent2 } }
        ],
        barWidth: 18,
        label: {
          show: true,
          position: 'right',
          color: ink,
          fontSize: 12,
          fontWeight: 600,
          formatter: function(p) { return p.value === 0 ? '无要求' : '$' + p.value + 'M'; }
        }
      },
      {
        type: 'bar',
        name: '典型估值',
        data: [
          { value: 6.5, itemStyle: { color: 'transparent', borderColor: accent, borderWidth: 2, borderType: 'dashed' } },
          { value: 5, itemStyle: { color: 'transparent', borderColor: accent, borderWidth: 2, borderType: 'dashed' } },
          { value: 200, itemStyle: { color: 'transparent', borderColor: accent2, borderWidth: 2, borderType: 'dashed' } }
        ],
        barWidth: 30,
        barGap: '-100%',
        label: {
          show: true,
          position: 'right',
          color: accent2,
          fontSize: 11,
          formatter: function(p) { return '估值 ~$' + p.value + 'M'; }
        }
      }
    ]
  });
  window.addEventListener('resize', function() { chart2.resize(); });

  // --- Chart 3: Radar Comparison ---
  var chart3 = echarts.init(document.getElementById('chart-radar'), null, { renderer: 'svg' });
  chart3.setOption({
    animation: false,
    tooltip: { appendToBody: true },
    radar: {
      center: ['50%', '55%'],
      radius: '65%',
      indicator: [
        { name: '社区规模', max: 100 },
        { name: '技术架构', max: 100 },
        { name: '企业安全', max: 100 },
        { name: '可观测性', max: 100 },
        { name: '商业化', max: 100 },
        { name: 'LLM Provider', max: 100 }
      ],
      axisName: { color: muted, fontSize: 11 }
    },
    series: [{
      type: 'radar',
      data: [
        {
          name: 'Commander',
          value: [2, 85, 90, 75, 5, 95],
          lineStyle: { color: accent, width: 2 },
          areaStyle: { color: accent + '22' },
          itemStyle: { color: accent },
          symbol: 'circle',
          symbolSize: 6
        },
        {
          name: 'LangChain',
          value: [90, 80, 55, 85, 85, 60],
          lineStyle: { color: accent2, width: 1.5, type: 'dashed' },
          areaStyle: { color: 'transparent' },
          itemStyle: { color: accent2 },
          symbol: 'diamond',
          symbolSize: 5
        },
        {
          name: 'CrewAI',
          value: [35, 60, 30, 30, 50, 40],
          lineStyle: { color: muted, width: 1, type: 'dashed' },
          areaStyle: { color: 'transparent' },
          itemStyle: { color: muted },
          symbol: 'triangle',
          symbolSize: 5
        }
      ]
    }]
  });
  window.addEventListener('resize', function() { chart3.resize(); });

  // --- Chart 4: Gap Priority Matrix (Scatter) ---
  var chart4 = echarts.init(document.getElementById('chart-gap-matrix'), null, { renderer: 'svg' });

  var gapData = [
    { name: '定价模型', value: [9, 9.5], priority: 'P0' },
    { name: '网站/社区', value: [9, 9], priority: 'P0' },
    { name: 'SOC 2', value: [9.5, 7], priority: 'P0' },
    { name: 'API文档站', value: [8, 8], priority: 'P0' },
    { name: 'DPA模板', value: [8, 6], priority: 'P0' },
    { name: 'DB迁移', value: [7, 5], priority: 'P0' },
    { name: '健康检查桩', value: [6, 4], priority: 'P0' },
    { name: 'RBAC细粒度', value: [6, 5], priority: 'P1' },
    { name: '测试覆盖率', value: [5, 6], priority: 'P1' },
    { name: 'Web前端测试', value: [5, 4], priority: 'P1' },
    { name: 'SaaS MVP', value: [7, 7], priority: 'P1' },
    { name: '可观测重构', value: [4, 5], priority: 'P1' },
    { name: 'Helm完善', value: [3, 3], priority: 'P2' },
    { name: 'IaC模板', value: [3, 2], priority: 'P2' },
    { name: '清理TODO', value: [2, 3], priority: 'P2' }
  ];

  chart4.setOption({
    animation: false,
    tooltip: {
      appendToBody: true,
      formatter: function(p) { return p.name + '<br/>影响度: ' + p.value[0] + '/10<br/>修复难度: ' + p.value[1] + '/10<br/>优先级: ' + gapData[p.dataIndex].priority; }
    },
    grid: { left: 60, right: 30, top: 20, bottom: 50 },
    xAxis: {
      name: '业务影响度 →',
      nameTextStyle: { color: muted, fontSize: 11 },
      max: 10,
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted, fontSize: 11 }
    },
    yAxis: {
      name: '修复难度 →',
      nameTextStyle: { color: muted, fontSize: 11 },
      max: 10,
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted, fontSize: 11 }
    },
    series: [{
      type: 'scatter',
      data: gapData.map(function(d) {
        return {
          value: d.value,
          name: d.name,
          symbolSize: d.priority === 'P0' ? 18 : (d.priority === 'P1' ? 14 : 10),
          itemStyle: {
            color: d.priority === 'P0' ? '#dc2626' : (d.priority === 'P1' ? '#ea580c' : '#ca8a04'),
            opacity: 0.85
          }
        };
      }),
      label: {
        show: true,
        position: 'right',
        fontSize: 11,
        color: ink,
        formatter: function(p) { return p.name; }
      }
    }]
  });
  window.addEventListener('resize', function() { chart4.resize(); });

  // --- Chart 5: Timeline & Valuation ---
  var chart5 = echarts.init(document.getElementById('chart-timeline'), null, { renderer: 'svg' });

  var phases = ['Phase 0\n当前', 'Phase 1\n基础', 'Phase 2\n验证', 'Phase 3\n增长', 'Phase 4\n退出'];
  var months = [0, 3, 6, 12, 24];
  var valLow = [1, 3, 8, 15, 50];
  var valHigh = [3, 8, 15, 30, 200];

  chart5.setOption({
    animation: false,
    tooltip: { appendToBody: true, trigger: 'axis' },
    grid: { left: 60, right: 30, top: 20, bottom: 50 },
    xAxis: {
      type: 'category',
      data: phases,
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      name: '估值 ($M)',
      nameTextStyle: { color: muted, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted, fontSize: 12 }
    },
    series: [
      {
        type: 'line',
        name: '估值上限',
        data: valHigh,
        lineStyle: { color: accent2, width: 1, type: 'dashed' },
        itemStyle: { color: accent2 },
        symbol: 'circle',
        symbolSize: 6,
        label: {
          show: true,
          position: 'top',
          color: accent2,
          fontSize: 11,
          formatter: function(p) { return '$' + p.value + 'M'; }
        }
      },
      {
        type: 'line',
        name: '估值下限',
        data: valLow,
        lineStyle: { color: accent, width: 2.5 },
        itemStyle: { color: accent },
        symbol: 'circle',
        symbolSize: 8,
        areaStyle: { color: accent + '18' },
        label: {
          show: true,
          position: 'bottom',
          color: accent,
          fontSize: 11,
          fontWeight: 600,
          formatter: function(p) { return '$' + p.value + 'M'; }
        }
      }
    ]
  });
  window.addEventListener('resize', function() { chart5.resize(); });

})();