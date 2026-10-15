import {ensureTestDom,GlobalRegistrator} from '../../lib/test-dom-setup';
import {afterAll,afterEach,beforeEach,expect,test} from 'bun:test';
import React,{act} from 'react';
import type {Root} from 'react-dom/client';
import type {AssistantObjectSnapshot} from '@reomi/shared';
ensureTestDom();const {createRoot}=await import('react-dom/client');const {NotebookScopePicker}=await import('./notebook-scope-picker');
let root:Root,host:HTMLDivElement,oldFetch:typeof fetch;
beforeEach(()=>{ensureTestDom();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;oldFetch=globalThis.fetch;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=oldFetch;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>{try{GlobalRegistrator.unregister();}catch{}});
test('clearing notebook sources saves an explicit empty selection without changing the notebook',async()=>{
  const object:AssistantObjectSnapshot={ref:{kind:'notebook',id:'book'},label:'Notebook',available:true};let applied:AssistantObjectSnapshot|undefined;const writes:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{if(init?.method==='POST'){writes.push(String(url));const ref=JSON.parse(init.body).refs[0];return Response.json({items:[{ref,label:'Notebook',available:true}]});}return Response.json({items:[{id:'a',title:'First'},{id:'b',title:'Second'}]});}) as typeof fetch;
  await act(async()=>root.render(<NotebookScopePicker object={object} onApply={next=>{applied=next;}}/>));
  await act(async()=>host.querySelector('button')!.click());expect(document.querySelectorAll('input:checked')).toHaveLength(2);
  await act(async()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='assistant.clearSources')!.click());
  await act(async()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='actions.save')!.click());
  expect(applied!.ref).toEqual({kind:'notebook',id:'book',sourceIds:[]});expect(writes).toHaveLength(1);expect(writes[0]).toContain('/chat/context/resolve');
});
