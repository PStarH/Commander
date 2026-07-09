(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim() || '#18181b';
  var muted = style.getPropertyValue('--muted').trim() || '#71717a';
  var rule = style.getPropertyValue('--rule').trim() || '#e4e4e7';
  var ink = style.getPropertyValue('--ink').trim() || '#18181b';

  var palette = {
    P0: '#18181b',
    P1: '#3f3f46',
    P2: '#71717a',
    P3: '#a1a1aa'
  };

  var data = [
    { name: 'InjecAgent', x: 95, y: 85, size: 18, priority: 'P0' },
    { name: 'CyberSecEval 4', x: 90, y: 90, size: 22, priority: 'P0' },
    { name: 'HarmBench', x: 88, y: 87, size: 18, priority: 'P0' },
    { name: 'AgentAuditor / ASSEBench', x: 82, y: 75, size: 14, priority: 'P1' },
    { name: 'WebArena', x: 70, y: 85, size: 16, priority: 'P1' },
    { name: 'AgentBench', x: 65, y: 80, size: 18, priority: 'P1' },
    { name: 'GAIA', x: 60, y: 78, size: 14, priority: 'P2' },
    { name: 'MLCommons AILuminate', x: 55, y: 80, size: 14, priority: 'P2' },
    { name: '信通院 AI Safety Benchmark', x: 55, y: 70, size: 12, priority: 'P2' },
    { name: 'OSWorld', x: 40, y: 75, size: 14, priority: 'P3' },
    { name: 'CRAB', x: 42, y: 65, size: 12, priority: 'P3' },
    { name: 'SWE-bench', x: 30, y: 70, size: 12, priority: 'P3' }
  ];

  var seriesData = data.map(function(item) {
    return {
      name: item.name,
      value: [item.x, item.y, item.size, item.priority],
      itemStyle: { color: palette[item.priority] }
    };
  });

  var chart = echarts.init(document.getElementById('chart-priority-matrix'), null, { renderer: 'svg' });
  chart.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      formatter: function(params) {
        var v = params.value;
        return '<strong>' + params.name + '</strong><br/>' +
               '适配度: ' + v[0] + '<br/>' +
               '影响力: ' + v[1] + '<br/>' +
               '优先级: ' + v[3];
      }
    },
    grid: { top: 40, right: 40, bottom: 60, left: 70 },
    xAxis: {
      name: '与 Commander 架构适配度',
      nameLocation: 'middle',
      nameGap: 35,
      min: 20,
      max: 100,
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLine: { lineStyle: { color: ink } },
      axisLabel: { color: muted }
    },
    yAxis: {
      name: '外部公信力 / 社区影响力',
      nameLocation: 'middle',
      nameGap: 45,
      min: 50,
      max: 100,
      splitLine: { lineStyle: { color: rule, type: 'dashed' } },
      axisLine: { lineStyle: { color: ink } },
      axisLabel: { color: muted }
    },
    series: [{
      type: 'scatter',
      symbolSize: function(v) { return v[2]; },
      data: seriesData,
      label: {
        show: true,
        formatter: function(params) { return params.name; },
        position: 'right',
        color: ink,
        fontSize: 11,
        fontWeight: 600
      },
      markArea: {
        silent: true,
        itemStyle: { color: 'transparent', borderWidth: 1, borderType: 'dashed', borderColor: muted },
        data: [
          [
            { name: 'P0 高优区', xAxis: 80, yAxis: 80 },
            { xAxis: 100, yAxis: 100 }
          ],
          [
            { name: 'P1 优先区', xAxis: 55, yAxis: 70 },
            { xAxis: 100, yAxis: 80 }
          ]
        ],
        label: {
          show: true,
          position: 'insideTopLeft',
          color: muted,
          fontSize: 10,
          offset: [4, 4]
        }
      }
    }]
  });

  window.addEventListener('resize', function() { chart.resize(); });
})();
