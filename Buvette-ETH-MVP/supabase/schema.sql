-- Buvette ETH — exécuter dans l’éditeur SQL Supabase.
create extension if not exists pgcrypto;
create type public.user_role as enum ('admin','staff');
create type public.transaction_type as enum ('credit','purchase','reversal');
create type public.payment_method as enum ('cash','cheque');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role public.user_role not null default 'staff',
  created_at timestamptz not null default now()
);
create table public.customers (
  id uuid primary key default gen_random_uuid(), member_number text not null unique,
  full_name text not null, active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id) default auth.uid()
);
create table public.products (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  price_cents integer not null check(price_cents > 0), color text not null default '#6b1d5c',
  sort_order integer not null default 0, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.transactions (
  id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id),
  type public.transaction_type not null, amount_cents integer not null check(amount_cents <> 0),
  product_id uuid references public.products(id), unit_price_cents integer,
  payment_method public.payment_method, cheque_reference text, reversal_of uuid unique references public.transactions(id),
  request_id uuid not null unique, note text, created_by uuid not null references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  constraint transaction_details check (
    (type='credit' and amount_cents>0 and payment_method is not null and product_id is null) or
    (type='purchase' and amount_cents<0 and product_id is not null and unit_price_cents>0 and payment_method is null) or
    (type='reversal' and reversal_of is not null)
  ),
  constraint cheque_reference_required check(payment_method<>'cheque' or length(trim(cheque_reference))>0)
);
create index transactions_customer_date_idx on public.transactions(customer_id,created_at desc);
create view public.customer_balances with (security_invoker=true) as
select c.id,c.member_number,c.full_name,c.active,c.created_at,coalesce(sum(t.amount_cents),0)::integer balance_cents
from public.customers c left join public.transactions t on t.customer_id=c.id group by c.id;

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from profiles where id=auth.uid() and role in ('admin','staff'));
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from profiles where id=auth.uid() and role='admin');
$$;

create or replace function public.purchase_product(p_customer_id uuid,p_product_id uuid,p_request_id uuid)
returns table(transaction_id uuid,new_balance_cents integer) language plpgsql security definer set search_path=public as $$
declare v_price integer;v_balance integer;v_tx uuid;
begin
 if not is_staff() then raise exception 'UNAUTHORIZED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text,0));
 select price_cents into v_price from products where id=p_product_id and active=true;
 if v_price is null then raise exception 'PRODUCT_UNAVAILABLE'; end if;
 if not exists(select 1 from customers where id=p_customer_id and active=true) then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
 select coalesce(sum(amount_cents),0)::integer into v_balance from transactions where customer_id=p_customer_id;
 if v_balance<v_price then raise exception 'INSUFFICIENT_FUNDS'; end if;
 insert into transactions(customer_id,type,amount_cents,product_id,unit_price_cents,request_id)
 values(p_customer_id,'purchase',-v_price,p_product_id,v_price,p_request_id) returning id into v_tx;
 return query select v_tx,v_balance-v_price;
end;$$;

create or replace function public.credit_customer(p_customer_id uuid,p_amount_cents integer,p_payment_method public.payment_method,p_cheque_reference text,p_request_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tx uuid;
begin
 if not is_staff() then raise exception 'UNAUTHORIZED'; end if;
 if p_amount_cents<=0 then raise exception 'INVALID_AMOUNT'; end if;
 if p_payment_method='cheque' and coalesce(length(trim(p_cheque_reference)),0)=0 then raise exception 'CHEQUE_REFERENCE_REQUIRED'; end if;
 insert into transactions(customer_id,type,amount_cents,payment_method,cheque_reference,request_id)
 values(p_customer_id,'credit',p_amount_cents,p_payment_method,p_cheque_reference,p_request_id) returning id into v_tx;
 return v_tx;
end;$$;

create or replace function public.reverse_transaction(p_transaction_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_old transactions%rowtype;v_tx uuid;
begin
 if not is_staff() then raise exception 'UNAUTHORIZED'; end if;
 select * into v_old from transactions where id=p_transaction_id for update;
 if not found or v_old.type<>'purchase' then raise exception 'NOT_REVERSIBLE'; end if;
 if v_old.created_by<>auth.uid() and not is_admin() then raise exception 'UNAUTHORIZED_REVERSAL'; end if;
 if now()-v_old.created_at>interval '10 minutes' and not is_admin() then raise exception 'REVERSAL_DELAY_EXCEEDED'; end if;
 insert into transactions(customer_id,type,amount_cents,reversal_of,request_id,note)
 values(v_old.customer_id,'reversal',-v_old.amount_cents,v_old.id,gen_random_uuid(),'Annulation de vente') returning id into v_tx;
 return v_tx;
exception when unique_violation then raise exception 'ALREADY_REVERSED';
end;$$;

alter table profiles enable row level security;alter table customers enable row level security;alter table products enable row level security;alter table transactions enable row level security;
create policy "staff read profiles" on profiles for select to authenticated using(is_staff());
create policy "staff read customers" on customers for select to authenticated using(is_staff());
create policy "staff create customers" on customers for insert to authenticated with check(is_staff());
create policy "admin update customers" on customers for update to authenticated using(is_admin()) with check(is_admin());
create policy "staff read products" on products for select to authenticated using(is_staff());
create policy "admin create products" on products for insert to authenticated with check(is_admin());
create policy "admin update products" on products for update to authenticated using(is_admin()) with check(is_admin());
create policy "staff read transactions" on transactions for select to authenticated using(is_staff());
-- Les écritures passent exclusivement par les fonctions sécurisées.
grant select on profiles,customers,products,transactions,customer_balances to authenticated;
grant insert on customers to authenticated;grant update on customers,products to authenticated;grant insert on products to authenticated;
grant execute on function purchase_product(uuid,uuid,uuid),credit_customer(uuid,integer,payment_method,text,uuid),reverse_transaction(uuid) to authenticated;
alter publication supabase_realtime add table public.customers,public.products,public.transactions;

-- Après création du premier utilisateur dans Authentication > Users :
-- insert into public.profiles(id,display_name,role) values ('UUID_UTILISATEUR','Administrateur','admin');
-- Exemples facultatifs :
insert into public.products(name,price_cents,color,sort_order) values
 ('Café',100,'#6b1d5c',1),('Eau',150,'#0078a8',2),('Soda',250,'#e05206',3),('Sandwich',450,'#147a4b',4);

-- Durcissement : aucun appel anonyme des fonctions métier.
revoke execute on function public.purchase_product(uuid,uuid,uuid) from public, anon;
revoke execute on function public.credit_customer(uuid,integer,public.payment_method,text,uuid) from public, anon;
revoke execute on function public.reverse_transaction(uuid) from public, anon;
revoke execute on function public.is_staff(), public.is_admin() from public, anon;
grant execute on function public.is_staff(), public.is_admin() to authenticated;
