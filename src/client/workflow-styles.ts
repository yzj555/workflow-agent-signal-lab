/** Match the official conversation column and design tokens; no app-wide overrides. */
export const workflowCss = `
.wfr-view{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-chat-content-width,748px) + 64px);margin:0 auto;padding:28px 32px 32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:1.6;container-type:inline-size}
.wfr-view *{box-sizing:border-box}
.wfr-view-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0;margin-bottom:18px}
.wfr-section-label{color:var(--dsw-alias-label-tertiary);font-size:13px}
.wfr-status{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family);font-size:12px;line-height:20px;white-space:nowrap}
.wfr-status svg,.wfr-status>span:first-child{flex:none}
.wfr-status[data-tone=gate]{color:var(--dsw-alias-state-warn-primary)}
.wfr-status[data-tone=return]{color:var(--dsw-alias-state-error-primary)}
.wfr-status[data-tone=manual-close]{color:var(--dsw-alias-label-primary);font-weight:600}
.wfr-status[data-placement=header][data-tone=manual-close]{font-size:13px}
.wfr-status[data-tone=rollback]{color:var(--dsw-alias-label-secondary);font-weight:500}
.wfr-status[data-placement=header][data-tone=rollback]{position:relative;height:22px;padding-left:10px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:22px}
.wfr-status[data-placement=header][data-tone=rollback]:before{position:absolute;left:0;top:4px;width:1px;height:14px;background:var(--dsw-alias-border-l1);content:''}
.wfr-rollback-icon{flex:none;transform:scaleX(-1)}
.wfr-overview h2{margin:0;font-size:18px;line-height:28px;font-weight:600;overflow-wrap:anywhere}
.wfr-overview p{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}
.wfr-overview .wfr-rollback-heading{display:flex;align-items:center;gap:8px}
.wfr-result-summary strong{color:var(--dsw-alias-label-primary);font-weight:500}
.wfr-overview .wfr-task-context{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.wfr-view .wfr-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-completion{margin:16px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.wfr-orientation{margin:18px 0 0;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.wfr-orientation-row{display:grid;grid-template-columns:64px minmax(0,1fr);gap:14px;margin:0;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-orientation-row:first-child{border-top:0}
.wfr-orientation dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:21px}
.wfr-orientation dd{min-width:0;margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:21px;overflow-wrap:anywhere}
.wfr-orientation dd strong{display:block;font-weight:500}
.wfr-orientation dd span{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-orientation-row[data-needs-user=true] dt,.wfr-orientation-row[data-needs-user=true] dd strong{color:var(--dsw-alias-state-warn-primary)}
.wfr-track{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0;list-style:none;padding:0;margin:24px 0}
.wfr-step{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;padding:0 4px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wfr-step-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.wfr-step-name{color:var(--dsw-alias-label-secondary)}
.wfr-step-status{font-size:11px;line-height:17px;overflow-wrap:anywhere}
.wfr-step:before{content:'';position:absolute;top:11px;left:-50%;right:50%;height:1px;background:var(--dsw-alias-border-l2)}
.wfr-step:first-child:before{display:none}
.wfr-step-marker{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-step[data-state=current],.wfr-step[data-state=current] .wfr-step-name,.wfr-stage-row[data-state=current] strong{color:var(--dsw-alias-state-business-primary)}
[data-state=current]>.wfr-step-marker{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
[data-state=done]>.wfr-step-marker{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-state-success-primary)}
[data-state=failed]>.wfr-step-marker,[data-state=blocked]>.wfr-step-marker{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
[data-state=waiting]>.wfr-step-marker,[data-state=unconfirmed]>.wfr-step-marker{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
[data-state=merged]>.wfr-step-marker,[data-state=not_required]>.wfr-step-marker,[data-state=unavailable]>.wfr-step-marker,[data-state=not_run]>.wfr-step-marker{border-style:dashed}
.wfr-step[data-state=done] .wfr-step-status{color:var(--dsw-alias-state-success-primary)}
.wfr-view[data-rollback=true] [data-state=done]>.wfr-step-marker,.wfr-view[data-rollback=true] .wfr-step[data-state=done] .wfr-step-status{color:var(--dsw-alias-label-tertiary)}
.wfr-view [data-state=rolled_back]>.wfr-step-marker{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.wfr-step[data-state=rolled_back] .wfr-step-name,.wfr-stage-row[data-state=rolled_back] strong{color:var(--dsw-alias-label-primary);font-weight:500}
.wfr-step[data-state=rolled_back] .wfr-step-status{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}
.wfr-section{margin-top:24px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.wfr-section-heading h3{margin:0;font-size:14px;font-weight:500;line-height:24px}
.wfr-plan-summary{margin:4px 0 10px}
.wfr-plan-milestones{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));list-style:none;margin:0 0 12px;padding:0;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.wfr-plan-milestone{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:12px 14px;border-left:1px solid var(--dsw-alias-border-l1)}
.wfr-plan-milestone:first-child{border-left:0}
.wfr-plan-marker{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;margin-top:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.wfr-plan-marker[data-tone=done]{color:var(--dsw-alias-state-success-primary)}
.wfr-plan-marker[data-tone=current]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.wfr-plan-marker[data-tone=waiting]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.wfr-plan-marker[data-tone=failed]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.wfr-plan-milestone>div{min-width:0;flex:1}
.wfr-plan-milestone-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.wfr-plan-milestone-heading strong{font-size:13px;font-weight:500;line-height:20px}
.wfr-plan-milestone-heading em{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-style:normal;line-height:18px}
.wfr-plan-milestone[data-tone=done] .wfr-plan-milestone-heading em{color:var(--dsw-alias-state-success-primary)}
.wfr-plan-milestone[data-tone=current] .wfr-plan-milestone-heading em{color:var(--dsw-alias-state-business-primary)}
.wfr-plan-milestone[data-tone=waiting] .wfr-plan-milestone-heading em{color:var(--dsw-alias-state-warn-primary)}
.wfr-plan-milestone[data-tone=failed] .wfr-plan-milestone-heading em{color:var(--dsw-alias-state-error-primary)}
.wfr-plan-milestone p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;overflow-wrap:anywhere}
.wfr-plan-disclosure{margin-top:2px}
.wfr-plan-detail{padding:10px 0 2px 22px}
.wfr-plan-block{min-width:0;padding:13px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-plan-block:first-child{border-top:0}
.wfr-plan-block h4{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:22px}
.wfr-plan-block>p{margin:3px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px;overflow-wrap:anywhere}
.wfr-plan-block .wfr-plan-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-plan-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}
.wfr-plan-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.wfr-plan-list li{padding:2px 0;overflow-wrap:anywhere}
.wfr-plan-empty{margin:0}
.wfr-plan-definition{margin:6px 0 0}
.wfr-plan-definition>div{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-plan-definition dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-plan-definition dd{min-width:0;margin:0}
.wfr-plan-tasks,.wfr-plan-checks{list-style:none;margin:0;padding:0}
.wfr-plan-tasks>li,.wfr-plan-checks>li{padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-plan-tasks>li:first-child,.wfr-plan-checks>li:first-child{border-top:0}
.wfr-plan-task-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.wfr-plan-task-heading strong,.wfr-plan-checks strong{font-size:12px;font-weight:500;line-height:20px}
.wfr-plan-task-heading span{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.wfr-plan-tasks p{margin:2px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:19px;overflow-wrap:anywhere}
.wfr-plan-checks>li{display:flex;flex-direction:column;gap:2px}
.wfr-plan-checks span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.wfr-plan-checks small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.wfr-plan-checks code{max-width:100%;padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.wfr-agent-note{margin:6px 0 8px}
.wfr-agents{list-style:none;padding:0;margin:0}
.wfr-agent{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-agent:first-child{border-top:0}
.wfr-agent-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:22px;color:var(--dsw-alias-label-tertiary)}
.wfr-agent-copy{flex:1;min-width:0}
.wfr-agent-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.wfr-agent-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:22px}
.wfr-agent-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-agent-copy p{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px;overflow-wrap:anywhere}
.wfr-manual-record{margin-top:12px}
.wfr-verification-disclosure{margin-top:8px}
.wfr-verification-detail{min-width:0;padding:10px 0 4px 22px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:21px;overflow-wrap:anywhere}
.wfr-verification-detail h4{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.wfr-verification-detail p{margin:4px 0 10px;font-size:12px;line-height:21px;white-space:pre-wrap}
.wfr-verification-list{margin:0;padding-left:18px}
.wfr-verification-list>li{padding:6px 0}
.wfr-verification-list strong{font-weight:500;white-space:pre-wrap}
.wfr-verification-meta{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:19px}
.wfr-verification-meta>div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;padding:4px 0}
.wfr-verification-meta dt,.wfr-verification-meta dd{min-width:0;margin:0}
.wfr-learning-note{margin:6px 0 8px}
.wfr-learning-empty{margin:8px 0 0}
.wfr-learning-list{list-style:none;padding:0;margin:0}
.wfr-learning-item{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-learning-item:first-child{border-top:0}
.wfr-learning-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;min-width:0}
.wfr-learning-heading strong{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:22px;overflow-wrap:anywhere}
.wfr-learning-heading span{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-learning-item[data-tone=done] .wfr-learning-heading span{color:var(--dsw-alias-state-success-primary)}
.wfr-learning-item[data-tone=active] .wfr-learning-heading span{color:var(--dsw-alias-state-business-primary)}
.wfr-learning-item[data-tone=warning] .wfr-learning-heading span{color:var(--dsw-alias-state-warn-primary)}
.wfr-learning-item p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.wfr-stage-guide{padding:12px 0 0 22px}
.wfr-stage-row{display:flex;align-items:flex-start;gap:12px;padding:9px 0}
.wfr-stage-row strong{font-size:13px;line-height:22px;font-weight:500}
.wfr-stage-row p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-source{margin-top:20px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.wfr-source-label{overflow:hidden;min-width:0;margin-left:10px;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.wfr-source-detail{padding:8px 0 0 22px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-source-detail p{margin:6px 0}
.wfr-disclosure [role=button]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px;border-radius:4px}
.wfr-requirements-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.wfr-requirements-card{display:flex;overflow:hidden;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width);max-height:min(62vh,560px);border:1px solid var(--dsw-alias-border-l2);border-radius:20px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.wfr-requirements-card,.wfr-requirements-card *{box-sizing:border-box}
.wfr-requirements-header{display:flex;align-items:center;justify-content:space-between;flex:none;gap:16px;padding:11px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.wfr-requirements-heading{display:flex;align-items:center;min-width:0;gap:9px}
.wfr-requirements-heading>span:last-child{display:flex;flex-direction:column;min-width:0}
.wfr-requirements-heading strong{font-size:13px;font-weight:600;line-height:19px}
.wfr-requirements-heading small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.wfr-requirements-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}
.wfr-requirements-scope{flex:none;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:11px;font-weight:500;line-height:18px}
.wfr-requirements-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:14px 16px 0}
.wfr-requirements-question{flex:none;margin:0 0 9px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.wfr-requirements-detail{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:4px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.wfr-requirements-detail h1,.wfr-requirements-detail h2,.wfr-requirements-detail h3{margin:6px 0 8px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.wfr-requirements-detail p{margin:7px 0}
.wfr-requirements-detail blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.wfr-requirements-detail ul,.wfr-requirements-detail ol{margin:7px 0;padding-left:20px}
.wfr-requirements-boundary{display:flex;align-items:center;flex:none;flex-wrap:wrap;gap:8px 16px;margin-top:10px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.wfr-requirements-boundary span{display:inline-flex;align-items:center;gap:5px}
.wfr-requirements-boundary span:first-child{color:var(--dsw-alias-state-business-primary);font-weight:500}
.wfr-requirements-footer{display:flex;align-items:center;justify-content:space-between;flex:none;gap:12px;padding:7px 16px 12px}
.wfr-requirements-feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.wfr-requirements-actions{display:flex;align-items:center;flex:none;gap:8px}
.wfr-recovery-frame{min-width:0}
.wfr-recovery-state{flex:none;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:18px}
.wfr-recovery-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 18px 12px;overflow-wrap:anywhere}
.wfr-recovery-summary,.wfr-recovery-caution{margin:8px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px}
.wfr-recovery-caution{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.wfr-recovery-disclosure{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:13px;line-height:22px}
.wfr-recovery-evidence{padding:8px 0 0 22px;font-size:12px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.wfr-recovery-evidence p{margin:8px 0}
.wfr-recovery-evidence ul,.wfr-recovery-evidence ol{margin:8px 0;padding-left:18px}
.wfr-recovery-evidence strong{font-weight:500;color:var(--dsw-alias-label-primary)}
.wfr-recovery-footer{flex-direction:column;align-items:stretch;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;gap:6px}
.wfr-recovery-footer .wfr-requirements-feedback{margin:0;overflow-wrap:anywhere}
.wfr-recovery-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.wfr-budget-detail{font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.wfr-budget-detail p{margin:12px 0}
.wfr-budget-detail strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wfr-budget-detail table{width:100%;table-layout:fixed;font-size:12px;line-height:20px}
.wfr-budget-detail th,.wfr-budget-detail td{overflow-wrap:anywhere;padding:8px}
@media(max-width:480px){.wfr-recovery-frame{padding:6px 12px 10px}.wfr-recovery-body{padding:12px}.wfr-recovery-actions>.wfr-requirements-actions{width:100%;justify-content:flex-end}.wfr-recovery-evidence,.wfr-verification-detail{padding-left:0}}
@container(max-width:550px){.wfr-track{grid-template-columns:1fr;gap:0;margin:20px 0}.wfr-step{flex-direction:row;justify-content:flex-start;text-align:left;min-height:40px;gap:12px;padding:0}.wfr-step-copy{flex:1;flex-direction:row;align-items:baseline;justify-content:space-between;gap:12px}.wfr-step-status{flex:none}.wfr-step:before{top:-8px;bottom:20px;left:11px;right:auto;width:1px;height:auto}.wfr-plan-milestones{grid-template-columns:1fr}.wfr-plan-milestone{border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}.wfr-plan-milestone:first-child{border-top:0}.wfr-plan-columns{grid-template-columns:1fr}.wfr-plan-detail{padding-left:0}.wfr-plan-task-heading{align-items:flex-start}.wfr-agent-heading{align-items:flex-start}.wfr-agent-heading strong{white-space:normal;overflow-wrap:anywhere}}
@media(max-width:760px){.wfr-view{padding:22px 20px 28px}.wfr-view-heading{gap:10px}.wfr-requirements-card{border-radius:16px}.wfr-requirements-body{padding:12px 12px 0}.wfr-requirements-footer{align-items:flex-end;padding:7px 12px 10px}.wfr-requirements-actions{flex-wrap:wrap;justify-content:flex-end}}
`
