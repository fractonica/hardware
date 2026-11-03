# sdmmc_card (design camera-c1 D9): hal::BlockStore over the SD/MMC host and FAT (esp_vfs_fat_sdmmc_mount). Drivers are
# the only code that includes sdmmc_cmd.h and esp_vfs_fat.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/sdmmc_card.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_sdmmc fatfs sdmmc vfs)
