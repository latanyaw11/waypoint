-- ============================================================
-- WAYPOINT — Seed data: starter celebrity/editorial guide library
-- Run this AFTER schema.sql. Safe to re-run (guarded by WHERE NOT EXISTS).
-- ============================================================

insert into celebrity_picks
  (celebrity_name, city, country, place_name, category, lat, lng, note, is_published, sort_weight)
select v.* from (values
  ('Anthony Bourdain', 'Hanoi', 'Vietnam',
   'Bún Chả Hương Liên', 'restaurant', 21.0079, 105.8469,
   'The bún chả spot made world-famous after his 2016 episode with Barack Obama — now informally nicknamed the Obama combo.',
   true, 100),

  ('Anthony Bourdain', 'Marseille', 'France',
   'Chez Fonfon', 'restaurant', 43.2870, 5.3540,
   'Old-school bouillabaisse house on the Vallon des Auffes he returned to for its unpretentious approach to the dish.',
   true, 90),

  ('Anthony Bourdain', 'Singapore', 'Singapore',
   'Tian Tian Hainanese Chicken Rice', 'restaurant', 1.2802, 103.8440,
   'A Maxwell Food Centre hawker stall he called out repeatedly as essential Singapore eating.',
   true, 90),

  ('Anthony Bourdain', 'Naples', 'Italy',
   'L''Antica Pizzeria da Michele', 'restaurant', 40.8497, 14.2622,
   'A two-topping, century-old pizzeria he held up as the standard against which all other pizza should be judged.',
   true, 80),

  ('Padma Lakshmi', 'New York', 'USA',
   'Katz''s Delicatessen', 'restaurant', 40.7223, -73.9874,
   'A go-to she has cited often for pastrami on rye — a classic Lower East Side institution.',
   true, 70),

  ('Guy Fieri', 'New York', 'USA',
   'Xi''an Famous Foods', 'restaurant', 40.7596, -73.8303,
   'Featured for its hand-pulled noodles and cumin lamb — a Diners Drive-Ins and Dives staple recommendation.',
   true, 70),

  ('David Chang', 'Tokyo', 'Japan',
   'Tsuta', 'restaurant', 35.7383, 139.7110,
   'One of the first ramen shops to earn a Michelin star, frequently referenced in his ramen-pilgrimage commentary.',
   true, 70)

) as v(celebrity_name, city, country, place_name, category, lat, lng, note, is_published, sort_weight)
where not exists (
  select 1 from celebrity_picks
  where place_name = v.place_name and city = v.city
);

