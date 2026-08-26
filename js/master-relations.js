import { supabase } from './supabase-client.js';

export async function loadMasterRelations() {
  const [channels, purchaseCategories, expenseCategories, items, purchaseMap, expenseMap, suppliers, supplierPurchase, supplierExpense] = await Promise.all([
    supabase.from('sales_channels').select('id,code,name,active,sort_order').eq('active',true).order('sort_order'),
    supabase.from('purchase_categories').select('id,name,active,sort_order').eq('active',true).order('sort_order').order('name'),
    supabase.from('expense_categories').select('id,name,active,pl_bucket').eq('active',true).order('name'),
    supabase.from('items').select('id,name,unit,gst_rate,master_rate,last_purchase_rate,reorder_level,active').eq('active',true).order('name'),
    supabase.from('purchase_category_items').select('purchase_category_id,item_id'),
    supabase.from('expense_category_items').select('expense_category_id,item_id'),
    supabase.from('suppliers').select('id,name,phone,email,contact_person,address,gstin,active').eq('active',true).order('name'),
    supabase.from('supplier_purchase_categories').select('supplier_id,purchase_category_id,is_fixed'),
    supabase.from('supplier_expense_categories').select('supplier_id,expense_category_id,is_fixed'),
  ]);
  const error = [channels,purchaseCategories,expenseCategories,items,purchaseMap,expenseMap,suppliers,supplierPurchase,supplierExpense].find(x=>x.error)?.error;
  if (error) throw error;
  return {
    channels: channels.data || [], purchaseCategories: purchaseCategories.data || [], expenseCategories: expenseCategories.data || [],
    items: items.data || [], salesMap: [], purchaseMap: purchaseMap.data || [], expenseMap: expenseMap.data || [],
    suppliers: suppliers.data || [], supplierPurchase: supplierPurchase.data || [], supplierExpense: supplierExpense.data || [],
  };
}

export function itemIdsForPurchaseCategory(rel, categoryId) { return new Set((rel.purchaseMap || []).filter(x => x.purchase_category_id === categoryId).map(x => x.item_id)); }
export function itemIdsForSalesChannel(rel, channelId) { return new Set(); }
export function itemIdsForExpenseCategory(rel, categoryId) { return new Set((rel.expenseMap || []).filter(x => x.expense_category_id === categoryId).map(x => x.item_id)); }
export function expenseItemIdsForCategory(rel, categoryId) { return itemIdsForExpenseCategory(rel, categoryId); }
export function expenseCategoriesForItem(rel, itemId) { return (rel.expenseMap || []).filter(x => x.item_id === itemId).map(x => x.expense_category_id); }
export function salesChannelsForItem(rel, itemId) { return []; }
export function purchaseCategoriesForItem(rel, itemId) { return (rel.purchaseMap || []).filter(x => x.item_id === itemId).map(x => x.purchase_category_id); }
export function suppliersForPurchaseCategory(rel, categoryId) { return (rel.supplierPurchase || []).filter(x => x.purchase_category_id === categoryId).map(x => x.supplier_id); }
export function fixedSupplierForPurchaseCategory(rel, categoryId) { const ids=(rel.supplierPurchase||[]).filter(x=>x.purchase_category_id===categoryId&&x.is_fixed).map(x=>x.supplier_id); return ids.length===1?ids[0]:null; }
export function suppliersForExpenseCategory(rel, categoryId) { return (rel.supplierExpense || []).filter(x => x.expense_category_id === categoryId).map(x => x.supplier_id); }
export function searchItems(items, query = '') { const q=String(query||'').trim().toLowerCase(); return !q ? (items||[]) : (items||[]).filter(i=>String(i.name||'').toLowerCase().includes(q)); }
export function uniqueCategoryForItem(rel, itemId, type) { const ids=type==='purchase'?purchaseCategoriesForItem(rel,itemId):expenseCategoriesForItem(rel,itemId); return ids.length===1?ids[0]:null; }
