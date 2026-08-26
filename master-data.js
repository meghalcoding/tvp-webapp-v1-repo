import { supabase, IS_CONFIGURED } from './supabase-client.js';
import { canDo } from './auth.js';
import { loadMasterRelations, itemIdsForPurchaseCategory, itemIdsForExpenseCategory } from './master-relations.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>`₹${Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const state=(el,text,bad=false)=>{if(el){el.textContent=text;el.className=`form-status ${bad?'error':'success'}`;}};
const modal=(screen,html)=>{const host=screen.querySelector('#master-modal');host.innerHTML=`<div class="modal-backdrop">${html}</div>`;host.querySelector('.modal-close')?.addEventListener('click',()=>host.innerHTML='');};

export async function renderMasterCategoriesScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML='<div class="placeholder-screen"><h2>Connect Supabase first</h2></div>';return;}
  if(!canDo(user,'edit_masters')){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2></div>';return;}
  const [{data:purchase,error:pe},{data:expense,error:ee},rel]=await Promise.all([
    supabase.from('purchase_categories').select('id,name,sort_order,active').order('sort_order').order('name'),
    supabase.from('expense_categories').select('id,name,pl_bucket,active').order('name'),
    loadMasterRelations()
  ]);
  if(pe||ee) throw pe||ee;
  const render=()=>{
    const purchaseRows=(purchase||[]).map(c=>{const count=itemIdsForPurchaseCategory(rel,c.id).size;const suppliers=rel.supplierPurchase.filter(x=>x.purchase_category_id===c.id).map(x=>rel.suppliers.find(s=>s.id===x.supplier_id)?.name).filter(Boolean);return `<div class="master-list-row"><div><strong>${esc(c.name)}</strong><small>${c.active?'Active':'Inactive'} · ${count} item${count===1?'':'s'}${suppliers.length?` · ${esc(suppliers.join(', '))}`:''}</small></div><div class="button-row"><button class="btn btn-small category-items" data-type="purchase" data-id="${c.id}">View</button><button class="btn btn-small edit-category" data-type="purchase" data-id="${c.id}">Edit</button></div></div>`;}).join('');
    const expenseRows=(expense||[]).map(c=>{const count=itemIdsForExpenseCategory(rel,c.id).size;const suppliers=rel.supplierExpense.filter(x=>x.expense_category_id===c.id).map(x=>rel.suppliers.find(s=>s.id===x.supplier_id)?.name).filter(Boolean);return `<div class="master-list-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.pl_bucket||'operating')} · ${count} item${count===1?'':'s'}${suppliers.length?` · ${esc(suppliers.join(', '))}`:''}</small></div><div class="button-row"><button class="btn btn-small category-items" data-type="expense" data-id="${c.id}">View</button><button class="btn btn-small edit-category" data-type="expense" data-id="${c.id}">Edit</button></div></div>`;}).join('');
    screen.innerHTML=`<div class="screen-head"><div><h1>Categories</h1><p>Create the categories that route items and suppliers throughout Purchase and Expense.</p></div><div class="button-row"><button class="btn btn-primary" id="new-purchase-category">+ Purchase Category</button><button class="btn btn-primary" id="new-expense-category">+ Expense Category</button></div></div><div class="grid grid-2"><div class="card"><div class="card-title">Purchase Categories</div><div class="master-list">${purchaseRows||'<p class="muted">No purchase categories yet.</p>'}</div></div><div class="card"><div class="card-title">Expense Categories</div><div class="master-list">${expenseRows||'<p class="muted">No expense categories yet.</p>'}</div></div></div><div class="card category-help"><strong>How routing works</strong><p class="muted">Items can belong to multiple categories. Suppliers can be linked to multiple Purchase and Expense categories. A fixed Purchase supplier is automatically selected when that category is used.</p></div><div id="master-modal"></div>`;
    screen.querySelector('#new-purchase-category').onclick=()=>categoryForm(screen,user,'purchase');
    screen.querySelector('#new-expense-category').onclick=()=>categoryForm(screen,user,'expense');
    screen.querySelectorAll('.category-items').forEach(b=>b.onclick=()=>categoryItems(screen,user,b.dataset.type,b.dataset.id));
    screen.querySelectorAll('.edit-category').forEach(b=>b.onclick=()=>categoryForm(screen,user,b.dataset.type,(b.dataset.type==='purchase'?purchase:expense).find(c=>c.id===b.dataset.id)));
  };
  render();
}

async function categoryForm(screen,user,type,category=null,{onCreated}={}){
  const isPurchase=type==='purchase';
  const rel=await loadMasterRelations();
  const links=(isPurchase?rel.supplierPurchase:rel.supplierExpense).filter(x=>(isPurchase?x.purchase_category_id:x.expense_category_id)===category?.id);
  const selected=new Set(links.map(x=>x.supplier_id));
  const fixed=links.find(x=>x.is_fixed)?.supplier_id||'';
  const supplierRows=rel.suppliers.map(s=>`<label class="check-label category-supplier-option"><input type="checkbox" name="supplier" value="${s.id}" ${selected.has(s.id)?'checked':''}> ${esc(s.name)}</label>`).join('');
  const fixedOptions=rel.suppliers.map(s=>`<option value="${s.id}" ${fixed===s.id?'selected':''}>${esc(s.name)}</option>`).join('');
  modal(screen,`<form class="modal-card category-form" id="category-form"><button type="button" class="modal-close">×</button><div class="form-eyebrow">MASTER DATA</div><h2>${category?'Edit':'New'} ${isPurchase?'Purchase':'Expense'} Category</h2><p class="muted">This category is a routing rule used throughout the application.</p><div class="field"><label>Category name</label><input name="name" maxlength="120" required autofocus placeholder="e.g. Main Raw Material" value="${esc(category?.name||'')}"></div>${isPurchase?'':`<input type="hidden" name="pl_bucket" value="${esc(category?.pl_bucket||'operating')}">`}${category?`<div class="field"><label>Status</label><select name="active"><option value="true" ${category.active?'selected':''}>Active</option><option value="false" ${!category.active?'selected':''}>Inactive</option></select></div>`:''}<div class="relationship-section"><h3>Supplier routing</h3><p class="muted">Only linked suppliers appear when this category is selected. These links do not change the supplier’s other categories.</p>${supplierRows?`<div class="category-supplier-list">${supplierRows}</div>${isPurchase?`<div class="field fixed-category-option"><label>Fixed Purchase supplier (optional)</label><select name="fixed_supplier"><option value="">No fixed supplier</option>${fixedOptions}</select></div><small class="muted">Choose one linked supplier when this category always comes from that vendor.</small>`:''}`:'<p class="muted">No suppliers exist yet. Create the category now and link a supplier later.</p>'}</div><div class="form-status"></div><div class="button-row"><button type="button" class="btn modal-close-action">Cancel</button><button class="btn btn-primary">${category?'Save changes':'Create category'}</button></div></form>`);
  const form=screen.querySelector('#category-form');
  form.querySelector('.modal-close-action').onclick=()=>screen.querySelector('#master-modal').innerHTML='';
  form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form);const feedback=form.querySelector('.form-status');let id=category?.id;let error;if(category){const args=isPurchase?{p_category_id:id,p_name:f.get('name').trim(),p_active:f.get('active')==='true'}:{p_category_id:id,p_name:f.get('name').trim(),p_pl_bucket:f.get('pl_bucket'),p_active:f.get('active')==='true'};({error}=await supabase.rpc(isPurchase?'update_purchase_category_master':'update_expense_category_master',args));}else{const args=isPurchase?{p_name:f.get('name').trim(),p_sort_order:0}:{p_name:f.get('name').trim(),p_pl_bucket:f.get('pl_bucket')};({data:id,error}=await supabase.rpc(isPurchase?'create_purchase_category':'create_expense_category',args));}if(error){state(feedback,error.message,true);return;}const {error:linkError}=await supabase.rpc('set_category_supplier_links',{p_category_type:type,p_category_id:id,p_supplier_ids:f.getAll('supplier'),p_fixed_supplier_id:isPurchase?(f.get('fixed_supplier')||null):null});if(linkError){state(feedback,linkError.message,true);return;}screen.querySelector('#master-modal').innerHTML='';if(onCreated) await onCreated(id); else await renderMasterCategoriesScreen(screen,user);});
}

async function categoryItems(screen,user,type,id){
  const rel=await loadMasterRelations();
  const category=(type==='purchase'?rel.purchaseCategories:rel.expenseCategories).find(x=>x.id===id);
  const ids=type==='purchase'?itemIdsForPurchaseCategory(rel,id):itemIdsForExpenseCategory(rel,id);
  const linked=rel.items.filter(i=>ids.has(i.id));
  const suppliers=(type==='purchase'?rel.supplierPurchase:rel.supplierExpense).filter(x=>(type==='purchase'?x.purchase_category_id:x.expense_category_id)===id).map(x=>{const s=rel.suppliers.find(s=>s.id===x.supplier_id);return s?`${esc(s.name)}${x.is_fixed?' · Fixed':''}`:null;}).filter(Boolean);
  modal(screen,`<section class="modal-card"><button class="modal-close">×</button><div class="form-eyebrow">${type==='purchase'?'PURCHASE':'EXPENSE'} CATEGORY</div><h2>${esc(category?.name||'Category')}</h2><div class="category-detail-grid"><div><span>Linked items</span><strong>${linked.length}</strong></div><div><span>Linked suppliers</span><strong>${suppliers.length}</strong></div></div><h3>Items</h3><div class="master-list">${linked.map(i=>`<div class="master-list-row"><div><strong>${esc(i.name)}</strong><small>${esc(i.unit||'')}</small></div></div>`).join('')||'<p class="muted">No items linked yet. Add the category while creating/editing an Item.</p>'}</div><h3>Suppliers</h3><div class="master-list">${suppliers.map(s=>`<div class="master-list-row"><div><strong>${s}</strong></div></div>`).join('')||'<p class="muted">No suppliers linked yet.</p>'}</div></section>`);
}

export async function renderSupplierMasterEnhanced(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML='<div class="placeholder-screen"><h2>Connect Supabase first</h2></div>';return;}
  if(!canDo(user,'edit_masters')){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2></div>';return;}
  const [{data:suppliers,error:se},rel]=await Promise.all([supabase.from('suppliers').select('id,name,phone,email,contact_person,address,gstin,active').order('active',{ascending:false}).order('name'),loadMasterRelations()]);
  if(se)throw se;
  screen.innerHTML=`<div class="screen-head"><div><h1>Suppliers</h1><p>Create suppliers organically and control exactly where each supplier appears.</p></div><button class="btn btn-primary" id="new-supplier">+ New supplier</button></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Supplier</th><th>Purchase categories</th><th>Expense categories</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>${(suppliers||[]).map(s=>{const pc=rel.supplierPurchase.filter(x=>x.supplier_id===s.id).map(x=>{const c=rel.purchaseCategories.find(c=>c.id===x.purchase_category_id);return c?`${c.name}${x.is_fixed?' · Fixed':''}`:null;}).filter(Boolean);const ec=rel.supplierExpense.filter(x=>x.supplier_id===s.id).map(x=>rel.expenseCategories.find(c=>c.id===x.expense_category_id)?.name).filter(Boolean);return `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(pc.join(', ')||'—')}</td><td>${esc(ec.join(', ')||'—')}</td><td>${esc(s.phone||s.email||'—')}</td><td>${s.active?'<span class="stamp settled">Active</span>':'<span class="stamp pending">Inactive</span>'}</td><td><button class="btn btn-small edit-supplier-enhanced" data-id="${s.id}">Edit</button></td></tr>`;}).join('')||'<tr><td colspan="6">No suppliers yet.</td></tr>'}</tbody></table></div><div id="master-modal"></div>`;
  const byId=new Map((suppliers||[]).map(s=>[s.id,s]));
  screen.querySelector('#new-supplier').onclick=()=>supplierEnhancedForm(screen,user,null,rel);
  screen.querySelectorAll('.edit-supplier-enhanced').forEach(b=>b.onclick=()=>supplierEnhancedForm(screen,user,byId.get(b.dataset.id),rel));
}

function supplierEnhancedForm(screen,user,supplier,rel,{onCreated}={},draft={}){
  const pcSelected=new Set(draft.purchase_category_ids || rel.supplierPurchase.filter(x=>x.supplier_id===supplier?.id).map(x=>x.purchase_category_id));
  const fixedSelected=new Set(draft.fixed_purchase_category_ids || rel.supplierPurchase.filter(x=>x.supplier_id===supplier?.id&&x.is_fixed).map(x=>x.purchase_category_id));
  const ecSelected=new Set(draft.expense_category_ids || rel.supplierExpense.filter(x=>x.supplier_id===supplier?.id).map(x=>x.expense_category_id));

  const linkDropdown=(key,title,options,selected,name,fixed=false)=>`
    <details class="link-dropdown supplier-link-dropdown" ${selected.size?'open':''}>
      <summary>${esc(title)} <span class="link-count">${selected.size?`${selected.size} selected`:'Choose…'}</span></summary>
      <div class="link-dropdown-menu">
        <div class="link-dropdown-search"><input type="search" placeholder="Search ${esc(title)} categories…" data-filter="${key}" autocomplete="off"></div>
        <div class="link-check-list" data-link-list="${key}">
          ${options.map(x=>fixed
            ? `<div class="supplier-category-row"><label class="check-label link-option" data-label="${esc(x.name.toLowerCase())}"><input type="checkbox" name="purchase_category" value="${x.id}" ${pcSelected.has(x.id)?'checked':''}> ${esc(x.name)}</label><label class="check-label fixed-label"><input type="checkbox" name="fixed_purchase_category" value="${x.id}" ${fixedSelected.has(x.id)?'checked':''}> Fixed</label></div>`
            : `<label class="check-label link-option" data-label="${esc(x.name.toLowerCase())}"><input type="checkbox" name="expense_category" value="${x.id}" ${ecSelected.has(x.id)?'checked':''}> ${esc(x.name)}</label>`
          ).join('')||'<span class="muted">No categories yet.</span>'}
        </div>
        <div class="link-dropdown-actions">
          <button type="button" class="btn btn-small add-inline-supplier-category" data-category-type="${key}">+ Add new category</button>
          <button type="button" class="btn btn-small link-dropdown-done">Done</button>
        </div>
      </div>
    </details>`;

  modal(screen,`<form class="modal-card" id="supplier-enhanced-form">
    <button type="button" class="modal-close">×</button>
    <div class="form-eyebrow">MASTER DATA</div>
    <h2>${supplier?'Edit':'New'} Supplier</h2>
    <p class="muted">A supplier only appears in Purchase or Expense when linked to the relevant category.</p>
    <div class="field"><label>Supplier / Vendor name</label><input name="name" required maxlength="120" value="${esc((draft.name ?? supplier?.name ?? ''))}" autofocus></div>
    <div class="form-grid">
      <div class="field"><label>Contact person</label><input name="contact_person" value="${esc((draft.contact_person ?? supplier?.contact_person ?? ''))}"></div>
      <div class="field"><label>Phone</label><input name="phone" value="${esc((draft.phone ?? supplier?.phone ?? ''))}"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc((draft.email ?? supplier?.email ?? ''))}"></div>
      <div class="field"><label>GSTIN</label><input name="gstin" value="${esc((draft.gstin ?? supplier?.gstin ?? ''))}"></div>
      <div class="field field-wide"><label>Address</label><textarea name="address" rows="2">${esc((draft.address ?? supplier?.address ?? ''))}</textarea></div>
      ${supplier?`<div class="field"><label>Status</label><select name="active"><option value="true" ${(draft.active??supplier.active)?'selected':''}>Active</option><option value="false" ${!(draft.active??supplier.active)?'selected':''}>Inactive</option></select></div>`:''}
    </div>
    <div class="relationship-section">
      <h3>Link To</h3>
      <p class="muted">Choose where this supplier is available. Purchase and Expense links are independent.</p>
      <div class="link-dropdown-grid supplier-link-grid">
        ${linkDropdown('purchase','Purchase',rel.purchaseCategories,pcSelected,'purchase_category',true)}
        ${linkDropdown('expense','Expense',rel.expenseCategories,ecSelected,'expense_category',false)}
      </div>
      <small class="muted">Fixed is only available for Purchase. It means this supplier is automatically selected for that category.</small>
    </div>
    <div class="form-status"></div>
    <div class="button-row"><button type="button" class="btn modal-close-action">Cancel</button><button class="btn btn-primary">${supplier?'Save changes':'Create supplier'}</button></div>
  </form>`);

  const form=screen.querySelector('#supplier-enhanced-form');
  form.querySelector('.modal-close-action').onclick=()=>screen.querySelector('#master-modal').innerHTML='';

  const refreshSummary=details=>{
    const count=details.querySelectorAll('input[name="purchase_category"]:checked,input[name="expense_category"]:checked').length;
    const type=details.querySelector('[data-filter]')?.dataset.filter;
    const selector=type==='purchase'?'input[name="purchase_category"]:checked':'input[name="expense_category"]:checked';
    const typeCount=details.querySelectorAll(selector).length;
    const countEl=details.querySelector('.link-count');
    if(countEl)countEl.textContent=typeCount?`${typeCount} selected`:'Choose…';
  };

  form.querySelectorAll('[data-filter]').forEach(inp=>inp.addEventListener('input',()=>{
    const q=inp.value.toLowerCase();
    const list=inp.closest('.link-dropdown')?.querySelector('.link-check-list');
    list?.querySelectorAll('.link-option').forEach(row=>row.style.display=row.dataset.label.includes(q)?'':'none');
  }));
  form.querySelectorAll('.link-dropdown input[type="checkbox"]').forEach(cb=>cb.addEventListener('change',()=>refreshSummary(cb.closest('.link-dropdown'))));
  form.querySelectorAll('.link-dropdown-done').forEach(btn=>btn.addEventListener('click',()=>btn.closest('.link-dropdown')?.removeAttribute('open')));

  form.querySelectorAll('.add-inline-supplier-category').forEach(btn=>btn.addEventListener('click',()=>{
    const current={
      name:form.elements.name.value,
      contact_person:form.elements.contact_person.value,
      phone:form.elements.phone.value,
      email:form.elements.email.value,
      gstin:form.elements.gstin.value,
      address:form.elements.address.value,
      active:form.elements.active?.value==='true',
      purchase_category_ids:[...form.querySelectorAll('input[name="purchase_category"]:checked')].map(x=>x.value),
      expense_category_ids:[...form.querySelectorAll('input[name="expense_category"]:checked')].map(x=>x.value),
      fixed_purchase_category_ids:[...form.querySelectorAll('input[name="fixed_purchase_category"]:checked')].map(x=>x.value)
    };
    const type=btn.dataset.categoryType;
    modal(screen,`<form class="modal-card" id="inline-supplier-category-form">
      <button type="button" class="modal-close">×</button>
      <div class="form-eyebrow">MASTER DATA</div>
      <h2>Add ${type==='purchase'?'Purchase':'Expense'} Category</h2>
      <p class="muted">Create the category and return to the supplier with it selected.</p>
      <div class="field"><label>Category name</label><input name="name" required maxlength="120" autofocus></div>
      ${type==='expense'?'<input type="hidden" name="pl_bucket" value="operating">':''}
      <div class="form-status"></div>
      <div class="button-row"><button type="button" class="btn modal-close-action">Cancel</button><button class="btn btn-primary">Create and return</button></div>
    </form>`);
    const catForm=screen.querySelector('#inline-supplier-category-form');
    catForm.querySelector('.modal-close-action').onclick=()=>supplierEnhancedForm(screen,user,supplier,rel,{},current);
    catForm.addEventListener('submit',async e=>{
      e.preventDefault();
      const fd=new FormData(catForm),feedback=catForm.querySelector('.form-status');
      const rpc=type==='purchase'?'create_purchase_category':'create_expense_category';
      const args=type==='purchase'?{p_name:fd.get('name').trim(),p_sort_order:0}:{p_name:fd.get('name').trim(),p_pl_bucket:fd.get('pl_bucket')};
      const {data:newId,error}=await supabase.rpc(rpc,args);
      if(error){state(feedback,error.message,true);return;}
      const fresh=await loadMasterRelations();
      if(type==='purchase')current.purchase_category_ids=[...new Set([...current.purchase_category_ids,newId])];
      else current.expense_category_ids=[...new Set([...current.expense_category_ids,newId])];
      supplierEnhancedForm(screen,user,supplier,fresh,{},current);
      requestAnimationFrame(()=>{
        const details=[...screen.querySelectorAll('#supplier-enhanced-form .link-dropdown')].find(d=>d.querySelector(`[data-filter="${type}"]`));
        details?.setAttribute('open','');
      });
    });
  }));

  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=new FormData(form),feedback=form.querySelector('.form-status');
    const base={p_name:f.get('name').trim(),p_phone:f.get('phone').trim()||null,p_contact_person:f.get('contact_person').trim()||null,p_email:f.get('email').trim()||null,p_address:f.get('address').trim()||null,p_gstin:f.get('gstin').trim()||null};
    let id=supplier?.id,error;
    if(id)({error}=await supabase.rpc('update_supplier_master',{p_supplier_id:id,...base,p_active:f.get('active')==='true'}));
    else ({data:id,error}=await supabase.rpc('create_supplier_master',base));
    if(error){state(feedback,error.message,true);return;}
    const pids=f.getAll('purchase_category'),eids=f.getAll('expense_category'),fixed=f.getAll('fixed_purchase_category');
    ({error}=await supabase.rpc('set_supplier_category_links',{p_supplier_id:id,p_purchase_category_ids:pids,p_expense_category_ids:eids,p_fixed_purchase_category_ids:fixed}));
    if(error){state(feedback,error.message,true);return;}
    screen.querySelector('#master-modal').innerHTML='';
    if(onCreated) await onCreated(id); else await renderSupplierMasterEnhanced(screen,user);
  });
}
