(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var green = style.getPropertyValue('--green').trim();
  var amber = style.getPropertyValue('--amber').trim();
  var red = style.getPropertyValue('--red').trim();
  var cyan = style.getPropertyValue('--cyan').trim();

  // --- Chart 1: Core Module Size Distribution ---
  var chartModules = echarts.init(document.getElementById('chart-modules'), null, { renderer: 'svg' });
  chartModules.setOption({
    animation: false,
    title: {
      text: '代码行数 (LOC)',
      left: 'right',
      top: 0,
      textStyle: { color: muted, fontSize: 12, fontWeight: 400 }
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: bg2,
      borderColor: rule,
      textStyle: { color: ink },
      appendToBody: true,
      formatter: function(params) {
        var p = params[0];
        return p.name + '<br/>代码行数: <b>' + p.value.toLocaleString() + '</b>';
      }
    },
    grid: { left: 130, right: 60, top: 30, bottom: 20 },
    xAxis: {
      type: 'value',
      axisLabel: { color: muted, fontSize: 11, formatter: function(v) { return (v / 1000) + 'K'; } },
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: [
        'shared/', 'tui/', 'reporting/', 'drive/', 'showcase/', 'goal/', 'plugins/',
        'swarm/', 'scheduler/', 'hub/', 'contracts/', 'compensation/', 'commander/',
        'evaluation/', 'infrastructure/', 'edit/', 'intelligence/', 'consensus/',
        'telos/', 'storage/', 'skills/', 'selfEvolution/', 'saga/', 'harness/',
        'tools/', 'sandbox/', 'atr/', 'observability/', 'memory/', 'cli/',
        'ultimate/', 'security/', 'runtime/'
      ],
      axisLabel: {
        color: ink,
        fontSize: 11,
        fontFamily: 'JetBrainsMono, monospace'
      },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'bar',
      data: [
        140, 8, 321, 451, 535, 688, 613, 849, 882, 925, 956, 1118, 1141,
        1284, 1446, 1562, 2014, 2140, 2199, 2414, 2782, 2893, 2926, 5512,
        7127, 7875, 7901, 8943, 9574, 12576, 16361, 66930, 69522
      ],
      itemStyle: {
        color: function(params) {
          var val = params.value;
          if (val > 50000) return red;
          if (val > 10000) return amber;
          if (val > 5000) return accent;
          if (val > 1000) return accent2;
          return muted;
        },
        borderRadius: [0, 3, 3, 0]
      },
      barWidth: '60%',
      label: {
        show: true,
        position: 'right',
        color: muted,
        fontSize: 10,
        fontFamily: 'JetBrainsMono, monospace',
        formatter: function(params) {
          if (params.value >= 1000) return (params.value / 1000).toFixed(1) + 'K';
          return params.value;
        }
      }
    }]
  });
  window.addEventListener('resize', function() { chartModules.resize(); });

  // --- Chart 2: Package Integration Status ---
  var chartPackages = echarts.init(document.getElementById('chart-packages'), null, { renderer: 'svg' });
  chartPackages.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      backgroundColor: bg2,
      borderColor: rule,
      textStyle: { color: ink },
      appendToBody: true,
      formatter: function(params) {
        return params.name + '<br/>占比: <b>' + params.percent + '%</b>';
      }
    },
    legend: {
      bottom: 10,
      textStyle: { color: muted, fontSize: 12 },
      itemWidth: 14,
      itemHeight: 14,
      itemGap: 20
    },
    series: [{
      type: 'pie',
      radius: ['42%', '70%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: true,
      itemStyle: {
        borderRadius: 6,
        borderColor: bg2,
        borderWidth: 2
      },
      label: {
        show: true,
        color: ink,
        fontSize: 13,
        fontWeight: 700,
        formatter: function(params) {
          return params.value + ' 个';
        }
      },
      labelLine: { show: false },
      data: [
        { value: 1, name: '核心（已集成）', itemStyle: { color: green } },
        { value: 2, name: '部分集成', itemStyle: { color: amber } },
        { value: 3, name: '未集成', itemStyle: { color: red } },
        { value: 1, name: '独立（HTTP）', itemStyle: { color: cyan } }
      ]
    }]
  });
  window.addEventListener('resize', function() { chartPackages.resize(); });

  // --- Mermaid Init ---
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      themeVariables: {
        primaryColor: '#1a2332',
        primaryTextColor: '#e6edf3',
        primaryBorderColor: '#3b82f6',
        lineColor: '#6b7785',
        secondaryColor: '#243044',
        tertiaryColor: '#0f1419',
        fontSize: '14px'
      },
      securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis' }
    });
  }
})();
