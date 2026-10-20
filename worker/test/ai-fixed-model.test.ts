import {it,expect,vi} from "vitest";
import {api,registerUser,testDb} from "./helpers";

it("normalizes legacy settings and lets the user switch to Gemini 3.8 Flash without replacing the key",async()=>{
 const u=await registerUser();const db=testDb();
 await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{provider:"gemini",key:"test-secret",acceptDataPolicy:true,storeOnServer:true}});
 await db.run("UPDATE ai_settings SET model='gemini-2.5-flash' WHERE user_id=?",u.userId);
 const before=await db.first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",u.userId);
 const legacy=await api("GET","/api/ai/settings",{cookie:u.cookie});
 expect(legacy.body.data).toMatchObject({model:"gemini-3.5-flash-lite",hasKey:true,dataPolicyAccepted:true,lastTest:null});

 const saved=await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{provider:"gemini",model:"gemini-3.8-flash",acceptDataPolicy:true,storeOnServer:true}});
 expect(saved.status).toBe(200);
 expect(saved.body.data.model).toBe("gemini-3.8-flash");
 expect((await db.first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",u.userId))!.key_enc).toBe(before!.key_enc);

 const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({candidates:[{content:{parts:[{text:JSON.stringify({candidates:[{hook:"test",body:"connected",comments:[],basis:"test"}]})}]}}]}));
 try{
  const tested=await api("POST","/api/ai/test",{cookie:u.cookie,body:{}});
  expect(tested.status).toBe(200);
  expect(tested.body.data.model).toBe("gemini-3.8-flash");
  expect(String(spy.mock.calls[0]![0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  expect((await api("GET","/api/ai/settings",{cookie:u.cookie})).body.data.lastTest.success).toBe(true);
 }finally{spy.mockRestore();}
});
