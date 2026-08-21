import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg=window.BUVETTE_CONFIG||{};
const supabase=createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
const $=id=>document.getElementById(id);
const money=cents=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(cents/100);
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
let profile=null, customers=[], products=[], selected=null, lastDebit=null, undoTimer=null;

function toast(message,error=false){const el=$('toast');el.textContent=message;el.style.background=error?'#b42318':'#272329';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
function cents(value){return Math.round(Number(value)*100)}
function showApp(ok){$('loginView').classList.toggle('hidden',ok);$('appView').classList.toggle('hidden',!ok)}

async function init(){
  if(!cfg.SUPABASE_URL||cfg.SUPABASE_URL.includes('VOTRE-')) $('loginError').textContent='Configuration Supabase manquante dans config.js';
  const {data:{session}}=await supabase.auth.getSession();
  if(session) await start(session.user);
  supabase.auth.onAuthStateChange(async(event,session)=>{if(event==='SIGNED_OUT'){profile=null;showApp(false)}else if(event==='SIGNED_IN'&&session) await start(session.user)});
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
}
async function start(user){
  const {data,error}=await supabase.from('profiles').select('id,display_name,role').eq('id',user.id).single();
  if(error){await supabase.auth.signOut();toast('Profil utilisateur introuvable',true);return}
  profile=data;$('userLabel').textContent=`${profile.display_name} · ${profile.role==='admin'?'Administrateur':'Staff'}`;
  $('adminTabBtn').classList.toggle('hidden',profile.role!=='admin');showApp(true);await loadAll();subscribeRealtime();
}
async function loadAll(){await Promise.all([loadCustomers(),loadProducts(),loadHistory()])}
async function loadCustomers(){
  const {data,error}=await supabase.from('customer_balances').select('*').order('full_name');if(error)return toast(error.message,true);
  customers=data||[];renderMembers();renderCreditOptions();if(selected){selected=customers.find(c=>c.id===selected.id)||null;renderSelected()}
}
async function loadProducts(){const {data,error}=await supabase.from('products').select('*').order('sort_order').order('name');if(error)return toast(error.message,true);products=data||[];renderProducts();renderAdminProducts()}
async function loadHistory(){
  const {data,error}=await supabase.from('transactions').select('id,created_at,type,amount_cents,payment_method,cheque_reference,note,reversal_of,customers(full_name),products(name),profiles(display_name)').order('created_at',{ascending:false}).limit(100);
  if(error)return toast(error.message,true);renderHistory(data||[])
}
function subscribeRealtime(){
  supabase.removeAllChannels();supabase.channel('buvette-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'transactions'},()=>{loadCustomers();loadHistory()})
    .on('postgres_changes',{event:'*',schema:'public',table:'customers'},loadCustomers)
    .on('postgres_changes',{event:'*',schema:'public',table:'products'},loadProducts).subscribe();
}

$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const {error}=await supabase.auth.signInWithPassword({email:$('email').value,password:$('password').value});if(error)$('loginError').textContent='Identifiants incorrects.'});
$('logoutBtn').onclick=()=>supabase.auth.signOut();
document.querySelectorAll('nav button').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('nav button,.tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(`${btn.dataset.tab}Tab`).classList.add('active')});

$('customerSearch').addEventListener('input',()=>{
  const q=$('customerSearch').value.trim().toLowerCase();if(!q){$('customerResults').innerHTML='';return}
  const hits=customers.filter(c=>c.active&&(c.full_name.toLowerCase().includes(q)||c.member_number.toLowerCase().includes(q))).slice(0,8);
  $('customerResults').innerHTML=hits.map(c=>`<button class="result" data-id="${c.id}"><span>${esc(c.full_name)}<br><small>${esc(c.member_number)}</small></span><strong>${money(c.balance_cents)}</strong></button>`).join('')||'<div class="result">Aucun résultat</div>';
  document.querySelectorAll('.result[data-id]').forEach(b=>b.onclick=()=>chooseCustomer(b.dataset.id));
});
function chooseCustomer(id){selected=customers.find(c=>c.id===id);$('customerSearch').value='';$('customerResults').innerHTML='';renderSelected()}
$('clearCustomer').onclick=()=>{selected=null;renderSelected()};
function renderSelected() {
  $('selectedCustomer').classList.toggle('hidden', !selected);
  $('selectHint').classList.toggle('hidden', !!selected);

  if (selected) {
    $('selectedName').textContent = selected.full_name;
    $('selectedBalance').textContent = money(selected.balance_cents);
    $('selectedBalance').style.color = selected.balance_cents < 0 ? '#ff4444' : 'inherit';
  }

  renderProducts();
}
function renderProducts(){
  $('products').innerHTML=products.filter(p=>p.active).map(p=>`<button class="product" style="background:${esc(p.color)}" data-id="${p.id}" ${!selected?'disabled':''}><span>${esc(p.name)}</span><strong>${money(p.price_cents)}</strong></button>`).join('');
  document.querySelectorAll('.product[data-id]').forEach(b=>b.onclick=()=>debit(b.dataset.id,b));
}
async function debit(productId, button) {
  if (!selected) return;

  button.disabled = true;

  const requestId = crypto.randomUUID();
  const { data, error } = await supabase.rpc('purchase_product', {
    p_customer_id: selected.id,
    p_product_id: productId,
    p_request_id: requestId
  });

  button.disabled = false;

  if (error) {
    return toast(
      error.message.includes('INSUFFICIENT_FUNDS')
        ? 'Solde insuffisant'
        : error.message,
      true
    );
  }

  // Supabase peut renvoyer une ligne dans un tableau.
  const result = Array.isArray(data) ? data[0] : data;

  if (!result || result.new_balance_cents == null) {
    await loadCustomers();
    return toast('Débit effectué, actualisation du solde', false);
  }

  const product = products.find(p => p.id === productId);
  selected.balance_cents = Number(result.new_balance_cents);
  lastDebit = result.transaction_id;

  renderSelected();

  $('undoText').textContent =
    `${product.name} débité (${money(product.price_cents)})`;
  $('undoBar').classList.remove('hidden');

  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 10000);
}
function hideUndo(){$('undoBar').classList.add('hidden');lastDebit=null}
$('undoBtn').onclick=async()=>{if(!lastDebit)return;const {error}=await supabase.rpc('reverse_transaction',{p_transaction_id:lastDebit});if(error)return toast(error.message,true);hideUndo();toast('Débit annulé')};

$('memberForm').addEventListener('submit',async e=>{e.preventDefault();const {error}=await supabase.from('customers').insert({full_name:$('memberName').value.trim(),member_number:$('memberNumber').value.trim()});if(error)return toast(error.message,true);e.target.reset();toast('Adhérent ajouté')});
function renderCreditOptions(){$('creditCustomer').innerHTML='<option value="">Choisir…</option>'+customers.filter(c=>c.active).map(c=>`<option value="${c.id}">${esc(c.full_name)} — ${esc(c.member_number)} (${money(c.balance_cents)})</option>`).join('')}
$('paymentMethod').onchange=()=>{$('chequeRefLabel').classList.toggle('hidden',$('paymentMethod').value!=='cheque');$('chequeRef').required=$('paymentMethod').value==='cheque'};
$('creditForm').addEventListener('submit',async e=>{e.preventDefault();const {error}=await supabase.rpc('credit_customer',{p_customer_id:$('creditCustomer').value,p_amount_cents:cents($('creditAmount').value),p_payment_method:$('paymentMethod').value,p_cheque_reference:$('paymentMethod').value==='cheque'?$('chequeRef').value.trim():null,p_request_id:crypto.randomUUID()});if(error)return toast(error.message,true);e.target.reset();$('chequeRefLabel').classList.add('hidden');toast('Compte crédité')});
function renderMembers() {
  $('memberList').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Adhérent</th>
          <th>Solde</th>
          ${profile.role === 'admin' ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
      ${customers.map(c => `
  <tr>
    <td>${esc(c.full_name)}</td>
   `<td><strong style="color: ${c.balance_cents < 0 ? '#ff4444' : 'inherit'}">${money(c.balance_cents)}</strong></td>`
    ${profile.role === 'admin' ? `<td><button class="danger delete-member" data-id="${c.id}">Supprimer</button></td>` : ''}
  </tr>
`).join('')}
      </tbody>
    </table>
  `;

  // Ajouter l'écouteur pour les boutons de suppression
  if (profile.role === 'admin') {
    document.querySelectorAll('.delete-member').forEach(btn => {
      btn.onclick = () => deleteMember(btn.dataset.id);
    });
  }
}
async function deleteMember(memberId) {
  // 1. Lire le solde depuis la VUE customer_balances
  const { data: member, error: fetchError } = await supabase
    .from('customer_balances')
    .select('balance_cents')
    .eq('id', memberId)
    .single();

  if (fetchError) {
    toast('Impossible de vérifier le solde du membre', true);
    return;
  }

  // 2. Vérifier que le solde est à 0
  if (member.balance_cents !== 0) {
    toast('Impossible de supprimer : le solde doit être à 0 €', true);
    return;
  }

  // 3. Confirmation
  if (!confirm('Êtes-vous sûr de vouloir supprimer ce membre ?')) {
    return;
  }

  try {
    // 4. Supprimer les transactions liées
    const { error: txError } = await supabase
      .from('transactions')
      .delete()
      .eq('customer_id', memberId);
    if (txError) throw txError;

    // 5. Supprimer le membre depuis la TABLE customers
    const { error: memberError } = await supabase
      .from('customers')
      .delete()
      .eq('id', memberId);
    if (memberError) throw memberError;

    // 6. Rafraîchir la liste
    toast('Membre supprimé avec succès');
    await loadCustomers();
  } catch (error) {
    toast(`Erreur : ${error.message}`, true);
  }
  }

function renderHistory(rows){$('historyList').innerHTML=`<table><thead><tr><th>Date</th><th>Adhérent</th><th>Opération</th><th>Montant</th><th>Staff</th></tr></thead><tbody>${rows.map(r=>{const credit=r.amount_cents>0;const label=r.type==='credit'?'Crédit '+(r.payment_method==='cheque'?'chèque':'espèces'):r.type==='reversal'?'Annulation':r.products?.name||'Débit';return `<tr><td>${new Date(r.created_at).toLocaleString('fr-FR')}</td><td>${esc(r.customers?.full_name)}</td><td>${esc(label)}</td><td class="amount ${credit?'credit':'debit'}">${credit?'+':''}${money(r.amount_cents)}</td><td>${esc(r.profiles?.display_name)}</td></tr>`}).join('')}</tbody></table>`}

$('productForm').addEventListener('submit',async e=>{e.preventDefault();if(profile.role!=='admin')return;const payload={name:$('productName').value.trim(),price_cents:cents($('productPrice').value),color:$('productColor').value};const id=$('productId').value;const {error}=id?await supabase.from('products').update(payload).eq('id',id):await supabase.from('products').insert(payload);if(error)return toast(error.message,true);resetProductForm();toast('Produit enregistré')});
$('cancelProductEdit').onclick=resetProductForm;
function resetProductForm(){$('productForm').reset();$('productColor').value='#6b1d5c';$('productId').value='';$('cancelProductEdit').classList.add('hidden')}
function renderAdminProducts(){
  $('adminProducts').innerHTML=products.map(p=>`<div class="admin-product"><span><strong>${esc(p.name)}</strong><br><small>${money(p.price_cents)} · ${p.active?'Actif':'Inactif'}</small></span><button class="ghost edit-product" data-id="${p.id}">Modifier</button><button class="${p.active?'danger':'ghost'} toggle-product" data-id="${p.id}">${p.active?'Désactiver':'Activer'}</button></div>`).join('');
  document.querySelectorAll('.edit-product').forEach(b=>b.onclick=()=>{const p=products.find(x=>x.id===b.dataset.id);$('productId').value=p.id;$('productName').value=p.name;$('productPrice').value=(p.price_cents/100).toFixed(2);$('productColor').value=p.color;$('cancelProductEdit').classList.remove('hidden')});
  document.querySelectorAll('.toggle-product').forEach(b=>b.onclick=async()=>{const p=products.find(x=>x.id===b.dataset.id);const {error}=await supabase.from('products').update({active:!p.active}).eq('id',p.id);if(error)toast(error.message,true)});
}
init();
