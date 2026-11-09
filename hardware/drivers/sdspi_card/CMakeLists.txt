# sdspi_card (design lcd-clock-c1 D6): hal::FileStore over an SPI-mode micro-SD and FAT (esp_vfs_fat_sdspi_mount) on
# fr_core's shared SPI bus. Drivers are the only code that includes sdmmc_cmd.h and esp_vfs_fat.h (spec 03 §3.2); the
# public header exposes fr_core types only.
idf_component_register(SRCS "src/sdspi_card.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_sdspi esp_driver_spi fatfs sdmmc vfs)
