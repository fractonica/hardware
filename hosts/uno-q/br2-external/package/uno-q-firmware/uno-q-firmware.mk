################################################################################
#
# uno-q-firmware
#
################################################################################

UNO_Q_FIRMWARE_SOURCE =
UNO_Q_FIRMWARE_DEPENDENCIES = linux-firmware
UNO_Q_FIRMWARE_LICENSE = linux-firmware (see the linux-firmware package)

# Mirrors the layout of Arduino's stock image. board-2.bin is linux-firmware's
# generic calibration; post-build.sh swaps in Arduino's per-PCB file from
# local/firmware/ when it is present.
UNO_Q_FIRMWARE_FILES = \
	ath10k/WCN3990/hw1.0/board-2.bin \
	ath10k/WCN3990/hw1.0/qcm2290/firmware-5.bin \
	ath10k/WCN3990/hw1.0/qcm2290/wlanmdsp.mbn \
	qca/apbtfw11.tlv \
	qca/apnv11.bin \
	qcom/a702_sqe.fw \
	qcom/qcm2290/a702_zap.mbn \
	qcom/qcm2290/adsp.mbn \
	qcom/qcm2290/adspr.jsn \
	qcom/qcm2290/adsps.jsn \
	qcom/qcm2290/adspua.jsn \
	qcom/qcm2290/modem.mbn \
	qcom/qcm2290/modemr.jsn \
	qcom/qcm2290/modemuw.jsn

define UNO_Q_FIRMWARE_INSTALL_TARGET_CMDS
	$(foreach f,$(UNO_Q_FIRMWARE_FILES),\
		$(INSTALL) -D -m 0644 $(LINUX_FIRMWARE_DIR)/$(f) \
			$(TARGET_DIR)/lib/firmware/$(f)$(sep))
	ln -sf ../../ath10k/WCN3990/hw1.0/qcm2290/wlanmdsp.mbn \
		$(TARGET_DIR)/lib/firmware/qcom/qcm2290/wlanmdsp.mbn
endef

$(eval $(generic-package))
