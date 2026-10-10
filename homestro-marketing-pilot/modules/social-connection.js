import {ZernioOrganic} from './zernio.js';
import {fail} from './core.js';

// Read-only setup check. Return only public identifiers, never provider tokens.
export async function inspectSocialConnection(env,fetchImpl=fetch) {
  const provider=new ZernioOrganic({apiKey:env.ZERNIO_API_KEY,accounts:{}},fetchImpl);
  const data=await provider.request('accounts');
  const accounts=data.accounts?.filter(a=>['tiktok','pinterest'].includes(a.platform)&&a.isActive===true);
  if(!accounts?.length||accounts.length>2)fail('ZERNIO_ACCOUNT_CONFIG_INVALID');
  const result={accounts:accounts.map(a=>({id:a._id,platform:a.platform,username:String(a.username||'')})),boards:[]};
  const pinterest=accounts.find(a=>a.platform==='pinterest');
  if(pinterest) {
    const data=await provider.request('accounts/'+pinterest._id+'/pinterest-boards');
    if(!Array.isArray(data.boards))fail('PINTEREST_BOARDS_INVALID');
    result.boards=data.boards.slice(0,100).map(b=>({id:String(b.id),name:String(b.name).slice(0,100),privacy:String(b.privacy)}));
  }
  return result;
}
