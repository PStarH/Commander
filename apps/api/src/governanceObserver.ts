// Governance Observer v1 - 治理观察者
// 统计高风险任务、审批率、风险 Agent 分布

export interface GovernanceStats {
  highRiskTasks: {
    total: number;
    completed: number;
    pending: number;
  };
  manualApprovalRate: number;
  agentRiskDistribution: Record<string, number>; // agentId -> high risk task count
  lastUpdated: string;
}

export interface GovernanceAlert {
  type: 'LESSON' | 'ISSUE' | 'WARNING';
  message: string;
  agentId?: string;
  timestamp: string;
}

// 计算治理统计
export function calculateGovernanceStats(
  missions: any[],
  agents: any[]
): GovernanceStats {
  const highRiskMissions = missions.filter(m => m.riskLevel === 'HIGH');
  
  const completed = highRiskMissions.filter(m => m.status === 'DONE').length;
  const pending = highRiskMissions.filter(m => m.status !== 'DONE').length;
  
  // 计算手动审批率
  const manualMissions = missions.filter(m => m.governanceMode === 'MANUAL');
  const approvedManual = manualMissions.filter(m => m.approvalStatus === 'APPROVED').length;
  const manualApprovalRate = manualMissions.length > 0 
    ? approvedManual / manualMissions.length 
    : 0;
  
  // Agent 风险分布
  const agentRiskDistribution: Record<string, number> = {};
  highRiskMissions.forEach(m => {
    if (m.assignedAgentId) {
      agentRiskDistribution[m.assignedAgentId] = 
        (agentRiskDistribution[m.assignedAgentId] || 0) + 1;
    }
  });
  
  return {
    highRiskTasks: {
      total: highRiskMissions.length,
      completed,
      pending
    },
    manualApprovalRate,
    agentRiskDistribution,
    lastUpdated: new Date().toISOString()
  };
}

// 生成治理警报
export function generateGovernanceAlerts(
  stats: GovernanceStats
): GovernanceAlert[] {
  const alerts: GovernanceAlert[] = [];
  
  // 高风险任务积压警告
  if (stats.highRiskTasks.pending > 5) {
    alerts.push({
      type: 'WARNING',
      message: `高风险任务积压: ${stats.highRiskTasks.pending} 个待处理`,
      timestamp: new Date().toISOString()
    });
  }
  
  // 审批率过低警告
  if (stats.manualApprovalRate < 0.5 && stats.highRiskTasks.total > 0) {
    alerts.push({
      type: 'ISSUE',
      message: `手动审批率过低: ${(stats.manualApprovalRate * 100).toFixed(1)}%`,
      timestamp: new Date().toISOString()
    });
  }
  
  // 高风险 Agent 识别
  for (const [agentId, count] of Object.entries(stats.agentRiskDistribution)) {
    if (count >= 3) {
      alerts.push({
        type: 'LESSON',
        message: `Agent ${agentId} 频繁执行高风险任务 (${count} 次)，需要关注`,
        agentId,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  return alerts;
}

// 生成周报格式的 ProjectMemory
export function generateWeeklyGovernanceReport(
  stats: GovernanceStats,
  alerts: GovernanceAlert[]
): string {
  const lines = [
    `# 治理周报 - ${new Date().toISOString().split('T')[0]}`,
    '',
    '## 高风险任务统计',
    `- 总数: ${stats.highRiskTasks.total}`,
    `- 已完成: ${stats.highRiskTasks.completed}`,
    `- 待处理: ${stats.highRiskTasks.pending}`,
    '',
    '## 审批统计',
    `- 手动审批率: ${(stats.manualApprovalRate * 100).toFixed(1)}%`,
    '',
    '## Agent 风险分布'
  ];
  
  for (const [agentId, count] of Object.entries(stats.agentRiskDistribution)) {
    lines.push(`- ${agentId}: ${count} 个高风险任务`);
  }
  
  if (alerts.length > 0) {
    lines.push('', '## 警报');
    alerts.forEach(a => {
      lines.push(`- [${a.type}] ${a.message}`);
    });
  }
  
  return lines.join('\n');
}
