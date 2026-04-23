-- ============================================================
-- Repano Reviews - 数据库规范化迁移脚本（方案一扩展版）
-- ============================================================
-- 将原来的单表 JSONB 设计拆分为三张关系表：
--   1. journals        - 每日日志（对应原来的 ReviewRecord）
--   2. journal_items   - 红榜/黑榜条目（对应 LogItem）
--   3. journal_item_qas - 条目的 QA 反思（对应 QaPair）
-- ============================================================

-- ------------------------------------------------------
-- 1. 创建触发器函数：自动更新 updated_at
-- ------------------------------------------------------
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ------------------------------------------------------
-- 2. 创建 journals 表（每日一条复盘记录）
--    id 使用 text 以兼容前端 randomId() 可能生成的非 UUID 字符串
-- ------------------------------------------------------
create table if not exists journals (
  id            text primary key,
  owner         text not null default 'default',
  journal_date  date not null,
  title         text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique(owner, journal_date)
);

comment on table journals is '每日复盘记录，一个人一天只有一条';

-- 自动更新 updated_at 触发器
drop trigger if exists trg_journals_updated_at on journals;
create trigger trg_journals_updated_at
  before update on journals
  for each row
  execute function update_updated_at_column();

-- 为常用查询建索引
create index if not exists idx_journals_owner_date on journals(owner, journal_date desc);
create index if not exists idx_journals_updated_at on journals(updated_at desc);

-- ------------------------------------------------------
-- 3. 创建 journal_items 表（红榜/黑榜条目）
-- ------------------------------------------------------
create table if not exists journal_items (
  id            text primary key,
  journal_id    text not null references journals(id) on delete cascade,
  type          text not null check (type in ('red', 'black')),
  content       text not null default '',
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  is_deleted    boolean not null default false
);

comment on table journal_items is '每天复盘下的具体条目（红榜/黑榜）';

-- 自动更新 updated_at 触发器
drop trigger if exists trg_journal_items_updated_at on journal_items;
create trigger trg_journal_items_updated_at
  before update on journal_items
  for each row
  execute function update_updated_at_column();

-- 索引
create index if not exists idx_journal_items_journal_id on journal_items(journal_id);
create index if not exists idx_journal_items_type_sort on journal_items(journal_id, type, sort_order);

-- ------------------------------------------------------
-- 4. 创建 journal_item_qas 表（深度反思 QA）
-- ------------------------------------------------------
create table if not exists journal_item_qas (
  id            text primary key,
  item_id       text not null references journal_items(id) on delete cascade,
  question      text not null default '',
  answer        text not null default '',
  show_answer   boolean not null default false,
  order_index   int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table journal_item_qas is '每条红榜/黑榜条目关联的深度反思 QA';

-- 自动更新 updated_at 触发器
drop trigger if exists trg_journal_item_qas_updated_at on journal_item_qas;
create trigger trg_journal_item_qas_updated_at
  before update on journal_item_qas
  for each row
  execute function update_updated_at_column();

-- 索引
create index if not exists idx_journal_item_qas_item_id on journal_item_qas(item_id);
create index if not exists idx_journal_item_qas_order on journal_item_qas(item_id, order_index);

-- ------------------------------------------------------
-- 5. RLS（行级安全）策略
--    当前阶段使用 service_role key 访问，RLS 先开启但允许所有
--    后续接入真实用户认证后可收紧为 owner = auth.uid()
-- ------------------------------------------------------

-- journals RLS
alter table journals enable row level security;

drop policy if exists "Allow all" on journals;
create policy "Allow all"
  on journals
  for all
  using (true)
  with check (true);

-- journal_items RLS
alter table journal_items enable row level security;

drop policy if exists "Allow all" on journal_items;
create policy "Allow all"
  on journal_items
  for all
  using (true)
  with check (true);

-- journal_item_qas RLS
alter table journal_item_qas enable row level security;

drop policy if exists "Allow all" on journal_item_qas;
create policy "Allow all"
  on journal_item_qas
  for all
  using (true)
  with check (true);

-- ------------------------------------------------------
-- 6. 数据迁移：从旧表 repano_reviews 迁移到新表
-- ------------------------------------------------------
-- 说明：
--   旧表结构：repano_reviews(owner text PK, payload jsonb, updated_at timestamptz)
--   payload 是 ReviewRecord[] 数组，每个元素结构：
--     { id, date, created_at, updated_at, today_log: { red: [...], black: [...] } }
--   其中 LogItem = { id, text, order_index, reflection_qas: [{ id, question, answer, showAnswer, order_index }] }
--
--   注意：迁移前先检查旧表是否存在，以及是否已有数据。
-- ------------------------------------------------------

do $$
declare
  rec record;
  review jsonb;
  item jsonb;
  qa jsonb;
  new_journal_id text;
  journal_date_val date;
  item_id_val text;
begin
  -- 检查旧表是否存在
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'repano_reviews'
  ) then
    raise notice '旧表 repano_reviews 不存在，跳过迁移';
    return;
  end if;

  -- 逐行迁移
  for rec in
    select owner, payload, updated_at from repano_reviews
    where payload is not null
  loop
    for review in select jsonb_array_elements(rec.payload)
    loop
      journal_date_val := coalesce((review->>'date')::date, current_date);
      new_journal_id := coalesce(review->>'id', gen_random_uuid()::text);

      -- 插入 journals
      insert into journals (id, owner, journal_date, created_at, updated_at)
      values (
        new_journal_id,
        rec.owner,
        journal_date_val,
        coalesce((review->>'created_at')::timestamptz, now()),
        coalesce((review->>'updated_at')::timestamptz, rec.updated_at, now())
      )
      on conflict (owner, journal_date) do update set
        updated_at = excluded.updated_at
      returning id into new_journal_id;

      -- 如果没拿到 id（冲突时），查出来
      if new_journal_id is null then
        select id into new_journal_id
        from journals
        where owner = rec.owner and journal_date = journal_date_val;
      end if;

      -- 迁移 red items
      for item in select jsonb_array_elements(review->'today_log'->'red')
      loop
        item_id_val := coalesce(item->>'id', gen_random_uuid()::text);
        insert into journal_items (id, journal_id, type, content, sort_order, created_at)
        values (
          item_id_val,
          new_journal_id,
          'red',
          coalesce(item->>'text', ''),
          coalesce((item->>'order_index')::int, 0),
          now()
        )
        on conflict (id) do update set
          content = excluded.content,
          sort_order = excluded.sort_order;
      end loop;

      -- 迁移 black items
      for item in select jsonb_array_elements(review->'today_log'->'black')
      loop
        item_id_val := coalesce(item->>'id', gen_random_uuid()::text);
        insert into journal_items (id, journal_id, type, content, sort_order, created_at)
        values (
          item_id_val,
          new_journal_id,
          'black',
          coalesce(item->>'text', ''),
          coalesce((item->>'order_index')::int, 0),
          now()
        )
        on conflict (id) do update set
          content = excluded.content,
          sort_order = excluded.sort_order;
      end loop;

      -- 迁移 reflection_qas（需要关联到对应的 item）
      -- 先遍历 red 和 black 的 items，再遍历每个 item 的 reflection_qas
      for item in
        select jsonb_array_elements(review->'today_log'->'red')
        union all
        select jsonb_array_elements(review->'today_log'->'black')
      loop
        item_id_val := coalesce(item->>'id', gen_random_uuid()::text);
        for qa in select jsonb_array_elements(item->'reflection_qas')
        loop
          insert into journal_item_qas (id, item_id, question, answer, show_answer, order_index, created_at)
          values (
            coalesce(qa->>'id', gen_random_uuid()::text),
            item_id_val,
            coalesce(qa->>'question', ''),
            coalesce(qa->>'answer', ''),
            coalesce((qa->>'showAnswer')::boolean, false),
            coalesce((qa->>'order_index')::int, 0),
            now()
          )
          on conflict (id) do update set
            question = excluded.question,
            answer = excluded.answer,
            show_answer = excluded.show_answer,
            order_index = excluded.order_index;
        end loop;
      end loop;

    end loop;
  end loop;

  raise notice '数据迁移完成';
end $$;

-- ------------------------------------------------------
-- 7. 常用查询视图（可选，方便调试）
-- ------------------------------------------------------

create or replace view v_journal_summary as
select
  j.id,
  j.owner,
  j.journal_date,
  j.updated_at,
  count(case when i.type = 'red' then 1 end) as red_count,
  count(case when i.type = 'black' then 1 end) as black_count,
  count(q.id) as qa_count
from journals j
left join journal_items i on i.journal_id = j.id and i.is_deleted = false
left join journal_item_qas q on q.item_id = i.id
group by j.id, j.owner, j.journal_date, j.updated_at;

comment on view v_journal_summary is '每日复盘汇总视图，方便调试和统计';
