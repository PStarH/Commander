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
  var orange = style.getPropertyValue('--orange').trim();

  // --- Chart 1: Radar — 三大维度成熟度 ---
  var radarEl = document.getElementById('chart-radar');
  if (radarEl) {
    var radar = echarts.init(radarEl, null, { renderer: 'svg' });
    radar.setOption({
      animation: false,
      tooltip: { trigger: 'item', appendToBody: true },
      legend: {
        data: ['当前评分', '生产级目标'],
        bottom: 0,
        textStyle: { color: muted, fontSize: 12 },
        itemGap: 20
      },
      radar: {
        indicator: [
          { name: '实时流式可见性', max: 10 },
          { name: '指标持久化', max: 10 },
          { name: '告警链完整性', max: 10 },
          { name: '成本可见性', max: 10 },
          { name: 'ATR 检查点恢复', max: 10 },
          { name: 'Saga 补偿回滚', max: 10 },
          { name: '文件系统可逆性', max: 10 },
          { name: '审批与守护', max: 10 },
          { name: '预算控制', max: 10 },
          { name: '灾难命令拦截', max: 10 }
        ],
        center: ['50%', '48%'],
        radius: '65%',
        axisName: {
          color: ink,
          fontSize: 11
        },
        splitLine: { lineStyle: { color: rule } },
        splitArea: { areaStyle: { color: [bg2, 'transparent'] } },
        axisLine: { lineStyle: { color: rule } }
      },
      series: [{
        type: 'radar',
        data: [
          {
            value: [6, 3, 3, 8, 9, 8, 5, 4, 7, 3],
            name: '当前评分',
            areaStyle: { color: accent + '33' },
            lineStyle: { color: accent, width: 2 },
            itemStyle: { color: accent }
          },
          {
            value: [9, 8, 9, 9, 9, 9, 8, 9, 8, 9],
            name: '生产级目标',
            areaStyle: { color: green + '15' },
            lineStyle: { color: green, width: 2, type: 'dashed' },
            itemStyle: { color: green }
          }
        ]
      }]
    });
    window.addEventListener('resize', function() { radar.resize(); });
  }

  // --- Chart 2: Heatmap — 灾难场景防护能力 ---
  var heatEl = document.getElementById('chart-heatmap');
  if (heatEl) {
    var heat = echarts.init(heatEl, null, { renderer: 'svg' });
    var scenarios = ['误删生产数据库', 'rm -rf 破坏性命令', '外部系统错误数据', '修改关键配置', '无限循环消耗资源'];
    var dimensions = ['前置拦截', '审批门控', '熔断隔离', 'Saga 补偿', '预算限制', '实时告警'];

    var heatData = [
      [0, 0, 1], [0, 1, 2], [0, 2, 3], [0, 3, 2], [0, 4, 3], [0, 5, 1],
      [1, 0, 2], [1, 1, 3], [1, 2, 4], [1, 3, 4], [1, 4, 4], [1, 5, 2],
      [2, 0, 1], [2, 1, 2], [2, 2, 3], [2, 3, 2], [2, 4, 3], [2, 5, 1],
      [3, 0, 3], [3, 1, 3], [3, 2, 4], [3, 3, 5], [3, 4, 4], [3, 5, 2],
      [4, 0, 5], [4, 1, 5], [4, 2, 5], [4, 3, 5], [4, 4, 5], [4, 5, 4]
    ];

    var labels = ['极弱', '弱', '中下', '中等', '良好', '强'];
    var colors = ['#5a2d2d', '#7a3a3a', '#8a6a2a', '#b8902a', '#3a8a4a', '#2a7a3a'];

    heat.setOption({
      animation: false,
      tooltip: {
        appendToBody: true,
        formatter: function(p) {
          return '<b>' + scenarios[p.value[1]] + '</b><br/>' +
            dimensions[p.value[0]] + ': <b>' + labels[p.value[2] - 1] + '</b>';
        }
      },
      grid: { top: 30, right: 30, bottom: 60, left: 120 },
      xAxis: {
        type: 'category',
        data: dimensions,
        splitArea: { show: false },
        axisLabel: { color: ink, fontSize: 11, interval: 0, rotate: 15 },
        axisLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: 'category',
        data: scenarios,
        splitArea: { show: false },
        axisLabel: { color: ink, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } }
      },
      visualMap: {
        min: 1,
        max: 5,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 14,
        itemHeight: 80,
        textStyle: { color: muted, fontSize: 10 },
        inRange: { color: colors },
        text: ['强', '极弱']
      },
      series: [{
        type: 'heatmap',
        data: heatData,
        label: {
          show: true,
          formatter: function(p) { return labels[p.value[2] - 1]; },
          color: '#fff',
          fontSize: 10
        },
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' }
        }
      }]
    });
    window.addEventListener('resize', function() { heat.resize(); });
  }
})();
