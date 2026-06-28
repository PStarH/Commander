(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  var axisLine = { lineStyle: { color: rule } };
  var axisLabel = { color: muted, fontSize: 11 };
  var splitLine = { lineStyle: { color: rule, type: 'dashed' } };

  // ---------- Chart 1: Observability Radar ----------
  var obsIndicator = [
    { name: '指标收集', max: 10 },
    { name: '分布式追踪', max: 10 },
    { name: '结构化日志', max: 10 },
    { name: '成本/Token', max: 10 },
    { name: '安全审计', max: 10 },
    { name: 'SLO/告警/事件', max: 10 },
    { name: '评估平台', max: 10 },
    { name: '仪表盘', max: 10 }
  ];
  var chartObs = echarts.init(document.getElementById('chart-obs-radar'), null, { renderer: 'svg' });
  chartObs.setOption({
    animation: false,
    tooltip: { appendToBody: true },
    legend: {
      data: ['Commander', '行业第一 (Langfuse+OTel)'],
      top: 0,
      textStyle: { color: muted, fontSize: 12 },
      itemGap: 20
    },
    radar: {
      indicator: obsIndicator,
      center: ['50%', '55%'],
      radius: '65%',
      axisName: { color: ink, fontSize: 11 },
      splitLine: splitLine,
      splitArea: { areaStyle: { color: ['transparent', bg2] } },
      axisLine: axisLine
    },
    series: [{
      type: 'radar',
      data: [
        { value: [9, 5, 6, 10, 9, 9, 6, 7], name: 'Commander', areaStyle: { color: accent + '33' }, lineStyle: { color: accent, width: 2 }, itemStyle: { color: accent } },
        { value: [8, 9, 7, 7, 4, 6, 9, 8], name: '行业第一 (Langfuse+OTel)', areaStyle: { color: accent2 + '22' }, lineStyle: { color: accent2, width: 2, type: 'dashed' }, itemStyle: { color: accent2 } }
      ]
    }]
  });
  window.addEventListener('resize', function () { chartObs.resize(); });

  // ---------- Chart 2: Reversibility Radar ----------
  var revIndicator = [
    { name: '事件溯源', max: 10 },
    { name: '重放恢复', max: 10 },
    { name: '确定性执行', max: 10 },
    { name: '补偿/Saga', max: 10 },
    { name: '死信队列', max: 10 },
    { name: '租约/围栏', max: 10 },
    { name: '幂等性', max: 10 },
    { name: '崩溃恢复', max: 10 }
  ];
  var chartRev = echarts.init(document.getElementById('chart-rev-radar'), null, { renderer: 'svg' });
  chartRev.setOption({
    animation: false,
    tooltip: { appendToBody: true },
    legend: {
      data: ['Commander', 'Temporal'],
      top: 0,
      textStyle: { color: muted, fontSize: 12 },
      itemGap: 20
    },
    radar: {
      indicator: revIndicator,
      center: ['50%', '55%'],
      radius: '65%',
      axisName: { color: ink, fontSize: 11 },
      splitLine: splitLine,
      splitArea: { areaStyle: { color: ['transparent', bg2] } },
      axisLine: axisLine
    },
    series: [{
      type: 'radar',
      data: [
        { value: [3, 5, 2, 9, 9, 9, 9, 6], name: 'Commander', areaStyle: { color: accent + '33' }, lineStyle: { color: accent, width: 2 }, itemStyle: { color: accent } },
        { value: [10, 10, 10, 5, 7, 8, 9, 10], name: 'Temporal', areaStyle: { color: accent2 + '22' }, lineStyle: { color: accent2, width: 2, type: 'dashed' }, itemStyle: { color: accent2 } }
      ]
    }]
  });
  window.addEventListener('resize', function () { chartRev.resize(); });

  // ---------- Chart 3: Distance to Top 1 (gap bar) ----------
  // gap = top1 - commander; negative = Commander leads
  var gapData = [
    { name: '事件溯源', gap: 7, domain: '可逆性' },
    { name: '确定性执行', gap: 8, domain: '可逆性' },
    { name: '重放恢复', gap: 5, domain: '可逆性' },
    { name: '崩溃恢复', gap: 4, domain: '可逆性' },
    { name: '分布式追踪', gap: 4, domain: '可观测性' },
    { name: '评估平台', gap: 3, domain: '可观测性' },
    { name: '仪表盘', gap: 1, domain: '可观测性' },
    { name: '结构化日志', gap: 1, domain: '可观测性' },
    { name: '幂等性', gap: 0, domain: '可逆性' },
    { name: '指标收集', gap: -1, domain: '可观测性' },
    { name: '租约/围栏', gap: -1, domain: '可逆性' },
    { name: '死信队列', gap: -2, domain: '可逆性' },
    { name: '成本/Token', gap: -3, domain: '可观测性' },
    { name: 'SLO/告警/事件', gap: -3, domain: '可观测性' },
    { name: '补偿/Saga', gap: -4, domain: '可逆性' },
    { name: '安全审计', gap: -5, domain: '可观测性' }
  ].sort(function (a, b) { return a.gap - b.gap; });

  var chartGap = echarts.init(document.getElementById('chart-gap-bar'), null, { renderer: 'svg' });
  chartGap.setOption({
    animation: false,
    tooltip: {
      appendToBody: true,
      formatter: function (p) {
        var d = gapData[p.dataIndex];
        var sign = d.gap > 0 ? '落后 ' : '领先 ';
        return d.name + '<br/>' + sign + Math.abs(d.gap) + ' 分 (' + d.domain + ')';
      }
    },
    grid: { left: 120, right: 80, top: 20, bottom: 20 },
    xAxis: {
      type: 'value',
      axisLine: axisLine,
      axisLabel: axisLabel,
      splitLine: splitLine
    },
    yAxis: {
      type: 'category',
      data: gapData.map(function (d) { return d.name; }),
      axisLine: axisLine,
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11 }
    },
    series: [{
      type: 'bar',
      data: gapData.map(function (d) {
        return {
          value: d.gap,
          itemStyle: { color: d.gap > 0 ? accent : accent2, borderRadius: d.gap > 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] }
        };
      }),
      barWidth: 14,
      label: {
        show: true,
        position: 'right',
        color: muted,
        fontSize: 10,
        formatter: function (p) {
          var v = p.value;
          return v > 0 ? '+' + v : String(v);
        }
      },
      markLine: {
        symbol: 'none',
        data: [{ xAxis: 0 }],
        lineStyle: { color: ink, width: 1.5 },
        label: { show: false }
      }
    }]
  });
  window.addEventListener('resize', function () { chartGap.resize(); });

  // ---------- Chart 4: Roadmap Priority Matrix ----------
  // x = effort (1 low - 5 high), y = impact (1 low - 5 high)
  var roadmapItems = [
    { name: '接线 EventSourcingEngine', effort: 1.8, impact: 4.6, phase: 'P0' },
    { name: '接线 RecoveryBootstrapper', effort: 1.2, impact: 4.2, phase: 'P0' },
    { name: '挂载 W3C 追踪中间件', effort: 1.5, impact: 3.8, phase: 'P0' },
    { name: '激活 PII 脱敏导出器', effort: 1.3, impact: 3.5, phase: 'P0' },
    { name: '持久化 ContractEventBus', effort: 2.2, impact: 3.6, phase: 'P1' },
    { name: '统一双套 MetricsCollector', effort: 2.5, impact: 2.8, phase: 'P1' },
    { name: 'Grafana/Prometheus 捆绑', effort: 2.0, impact: 3.0, phase: 'P1' },
    { name: '评估平台增强 (Judge/数据集)', effort: 3.5, impact: 4.0, phase: 'P1' },
    { name: 'GitSnapshot 索引持久化', effort: 1.6, impact: 3.2, phase: 'P1' },
    { name: 'Schema 迁移/回滚机制', effort: 3.2, impact: 3.4, phase: 'P2' },
    { name: '确定性执行约束', effort: 4.8, impact: 4.8, phase: 'P2' },
    { name: '合并三套 Saga 实现', effort: 4.0, impact: 2.5, phase: 'P2' }
  ];

  var chartMatrix = echarts.init(document.getElementById('chart-matrix'), null, { renderer: 'svg' });
  chartMatrix.setOption({
    animation: false,
    tooltip: {
      appendToBody: true,
      formatter: function (p) {
        return p.data.name + '<br/>阶段: ' + p.data.phase + ' | 影响: ' + p.data.impact + ' | 工作量: ' + p.data.effort;
      }
    },
    grid: { left: 60, right: 30, top: 30, bottom: 50 },
    xAxis: {
      name: '工作量 →',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { color: muted, fontSize: 11 },
      min: 0, max: 5.5,
      axisLine: axisLine,
      axisLabel: axisLabel,
      splitLine: splitLine
    },
    yAxis: {
      name: '影响 ↑',
      nameTextStyle: { color: muted, fontSize: 11 },
      min: 0, max: 5.5,
      axisLine: axisLine,
      axisLabel: axisLabel,
      splitLine: splitLine
    },
    series: [{
      type: 'scatter',
      data: roadmapItems.map(function (d) {
        return { name: d.name, value: [d.effort, d.impact], phase: d.phase, impact: d.impact, effort: d.effort };
      }),
      symbolSize: function (d) { return 16; },
      itemStyle: {
        color: function (p) {
          var m = { P0: accent2, P1: accent, P2: muted };
          return m[p.data.phase];
        },
        opacity: 0.85
      },
      label: {
        show: true,
        position: 'right',
        color: ink,
        fontSize: 10,
        formatter: function (p) { return p.data.name; }
      },
      markLine: {
        symbol: 'none',
        silent: true,
        lineStyle: { color: rule, type: 'dashed' },
        data: [{ xAxis: 2.75 }, { yAxis: 2.75 }]
      }
    }],
    graphic: [
      { type: 'text', left: '72%', top: '12%', style: { text: '速赢区', fill: accent2, fontSize: 11 } },
      { type: 'text', left: '20%', top: '12%', style: { text: '战略投资', fill: accent, fontSize: 11 } }
    ]
  });
  window.addEventListener('resize', function () { chartMatrix.resize(); });
})();
