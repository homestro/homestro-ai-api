'use strict';
function summarizeAutopilotResults(results) {
 const rows=results.map(r=>({id:r.id,processed:r.processed===true,complete:r.complete===true,skipped:r.skipped===true,error:r.error||null,reason:r.reason||null,pendingChecks:r.pendingChecks||r.qa?.reasons||[]}));
 return {processed:rows.filter(r=>r.processed).length,complete:rows.filter(r=>r.complete).length,skipped:rows.filter(r=>r.skipped).length,pending:rows.filter(r=>!r.complete&&!r.error).length,failed:rows.filter(r=>r.error).length,products:rows};
}
module.exports={summarizeAutopilotResults};
