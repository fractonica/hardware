#!/bin/bash
# Regenerates br2-external/board/uno-q/linux.config. Runs inside the build container.
#   stock Arduino config -> olddefconfig on the new kernel -> localmodconfig with
#   kernel-modules.txt -> qonu fragment -> drop every non-Qualcomm ARM platform.
set -euo pipefail
KVER=${KVER:-7.3.3}
BOARD=/src/br2-external/board/uno-q
WORK=/work/kconf
SRC=$WORK/linux-$KVER
mkdir -p "$WORK"
[ -d "$SRC" ] || tar -xf /work/dl/linux/linux-$KVER.tar.xz -C "$WORK"
OUT=$WORK/qonu
rm -rf "$OUT" "$WORK/ref" && mkdir -p "$OUT"
cd "$SRC"
make -s ARCH=arm64 mrproper
mk() { make -s ARCH=arm64 O="$OUT" "$@"; }

cp /src/board-snapshot/stock-6.16.7.config "$OUT/.config"
mk olddefconfig

# localmodconfig reads lsmod-style lines: "name size usedby"
grep -v '^#' "$BOARD/kernel-modules.txt" | tr -s ' \t' '\n' | sed '/^$/d' \
  | awk 'BEGIN{print "Module Size Used"} {print $1" 0 0"}' > "$WORK/lsmod.txt"
{ yes '' || true; } | mk LSMOD="$WORK/lsmod.txt" localmodconfig >/dev/null 2>&1

scripts/kconfig/merge_config.sh -m -O "$OUT" "$OUT/.config" "$BOARD/linux-fragment.config" >/dev/null
# Keep only the Qualcomm platform
for sym in $(sed -n 's/^config \(ARCH_[A-Z0-9_]*\)$/\1/p' arch/arm64/Kconfig.platforms); do
  [ "$sym" = ARCH_QCOM ] || scripts/config --file "$OUT/.config" --disable "$sym"
done
mk olddefconfig

# Fail loudly if the fragment did not stick
for want in CONFIG_EFI_STUB=y CONFIG_MMC_SDHCI_MSM=y CONFIG_EXT4_FS=y CONFIG_QCOM_WDT=y \
            CONFIG_USB_CONFIGFS_NCM=y CONFIG_USB_CONFIGFS_ACM=y CONFIG_ARCH_QCOM=y \
            CONFIG_CRYPTO_USER_API_HASH=y CONFIG_KEY_DH_OPERATIONS=y; do
  grep -qx "$want" "$OUT/.config" || { echo "MISSING: $want (got: $(grep "^${want%%=*}=" "$OUT/.config" || echo unset))"; exit 1; }
done

mk savedefconfig
cp "$OUT/defconfig" "$BOARD/linux.config"
echo "modules (=m): $(grep -c '=m$' "$OUT/.config")   built-in (=y): $(grep -c '=y$' "$OUT/.config")"

# Report Qualcomm-relevant options arm64 defconfig enables that we do not
mkdir -p "$WORK/ref" && make -s ARCH=arm64 O="$WORK/ref" defconfig
pat='QCOM|QCM2290|SM6115|AGATTI|MSM|GENI|RPM|SMD|SMEM|GLINK|SCM|SPMI|PM8|PMIC|ATH10K|QRTR|SDHCI|DWC3|ANX7625|TYPEC|ROLE|INTERCONNECT|RPROC|REMOTEPROC|RPMSG|PINCTRL|REGULATOR_QCOM|CPUFREQ|THERMAL|USB_GADGET'
echo "--- enabled in arm64 defconfig but not in linux.config (filtered):"
grep -E "^CONFIG_[A-Z0-9_]*($pat)[A-Z0-9_]*=[ym]" "$WORK/ref/.config" | cut -d= -f1 | while read -r s; do
  grep -qE "^$s=[ym]" "$OUT/.config" || echo "  $s"
done
