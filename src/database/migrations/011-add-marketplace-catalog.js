export async function up({ context: connection }) {
  await connection.query(`
    ALTER TABLE facilities
      ADD COLUMN city VARCHAR(120) NULL,
      ADD COLUMN city_normalized VARCHAR(120) NULL,
      ADD COLUMN address VARCHAR(250) NULL,
      ADD COLUMN description VARCHAR(1000) NULL,
      ADD COLUMN publication_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
      ADD COLUMN published_at DATETIME(6) NULL,
      ADD COLUMN published_by_user_id BIGINT UNSIGNED NULL,
      ADD COLUMN unpublished_at DATETIME(6) NULL,
      ADD KEY idx_facilities_catalog (publication_status, deactivated_at, name, id),
      ADD KEY idx_facilities_city (city_normalized, id),
      ADD CONSTRAINT fk_facilities_publisher FOREIGN KEY (published_by_user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      ADD CONSTRAINT chk_facilities_publication_status
        CHECK (publication_status IN ('DRAFT', 'PUBLISHED')),
      ADD CONSTRAINT chk_facilities_publication_fields CHECK (
        (publication_status = 'DRAFT' AND (
          (published_at IS NULL AND published_by_user_id IS NULL AND unpublished_at IS NULL)
          OR (published_at IS NOT NULL AND published_by_user_id IS NOT NULL
            AND unpublished_at IS NOT NULL AND unpublished_at >= published_at)
        ))
        OR (publication_status = 'PUBLISHED' AND published_at IS NOT NULL
          AND published_by_user_id IS NOT NULL AND unpublished_at IS NULL)
      ),
      ADD CONSTRAINT chk_facilities_city_fields CHECK (
        (city IS NULL AND city_normalized IS NULL)
        OR (city IS NOT NULL AND city_normalized IS NOT NULL)
      )
  `);

  await connection.query(`
    ALTER TABLE courts
      ADD COLUMN sport_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD KEY idx_courts_sport_active (sport_code, deactivated_at, facility_id, id)
  `);
}

export async function down({ context: connection }) {
  await connection.query('ALTER TABLE courts DROP KEY idx_courts_sport_active, DROP COLUMN sport_code');
  await connection.query(`
    ALTER TABLE facilities
      DROP FOREIGN KEY fk_facilities_publisher,
      DROP KEY idx_facilities_catalog,
      DROP KEY idx_facilities_city,
      DROP COLUMN city,
      DROP COLUMN city_normalized,
      DROP COLUMN address,
      DROP COLUMN description,
      DROP COLUMN publication_status,
      DROP COLUMN published_at,
      DROP COLUMN published_by_user_id,
      DROP COLUMN unpublished_at
  `);
}
