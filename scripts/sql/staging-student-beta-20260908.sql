-- Apply only to threads-autopilot-staging, after migration 0011.
-- License IDs are not the redeemable secret keys.
INSERT OR IGNORE INTO staging_beta_licenses(license_id) VALUES
 ('02633fb6-cd71-4cb1-a773-401847d13fd9'),
 ('f0b6d839-e9f7-4769-8744-ee524bcb8351'),
 ('ad0f6252-b358-461a-b2b5-d922f4c7f91c');
INSERT OR IGNORE INTO staging_beta_profiles(username) VALUES
 ('yonashi_kahannshinyase'),('lions.study'),('hikkoshi_makasete'),
 ('shiga_lunch_bakery'),('noricha.pht');
