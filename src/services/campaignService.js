const dayjs = require('dayjs');

const { AppError } = require('../lib/errors');

function createCampaignService({ prisma }) {
  async function getOfferById(offerId) {
    if (!offerId) {
      return null;
    }

    return prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        service: true,
        specialist: true
      }
    });
  }

  async function getCampaignById(campaignId) {
    if (!campaignId) {
      return null;
    }

    return prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        offer: true
      }
    });
  }

  function isOfferActive(offer, now = dayjs()) {
    if (!offer || !offer.active) {
      return false;
    }

    const startsAt = dayjs(offer.startsAt);
    const endsAt = dayjs(offer.endsAt);
    return now.isAfter(startsAt) && now.isBefore(endsAt);
  }

  function hasOfferCapacity(offer) {
    if (!offer) {
      return false;
    }

    if (offer.maxRedemptions == null) {
      return true;
    }

    return Number(offer.usedRedemptions || 0) < Number(offer.maxRedemptions);
  }

  function buildOfferSnapshot(offer, service) {
    const basePrice = Number(service?.price || 0);
    const discountValue = Number(offer?.discountValue || 0);
    let finalPrice = basePrice;

    if (offer?.discountType === 'PERCENTAGE') {
      finalPrice = Math.max(0, basePrice - Math.round((basePrice * discountValue) / 100));
    } else if (offer?.discountType === 'FIXED_AMOUNT') {
      finalPrice = Math.max(0, basePrice - discountValue);
    }

    return {
      offerId: offer.id,
      offerName: offer.name,
      discountType: offer.discountType,
      discountValue: offer.discountValue,
      customText: offer.customText || null,
      basePrice,
      finalPrice,
      currency: service?.currency || 'CLP',
      specialistId: offer.specialistId || null,
      serviceId: offer.serviceId || null
    };
  }

  async function resolveBookingOffer({ offerId, service }) {
    if (!offerId) {
      return null;
    }

    const offer = await getOfferById(offerId);
    if (!offer) {
      throw new AppError('La promocion asociada ya no existe.', 404);
    }

    if (offer.serviceId && offer.serviceId !== service.id) {
      throw new AppError('La promocion ya no aplica al servicio seleccionado.', 409);
    }

    if (!isOfferActive(offer)) {
      throw new AppError('La promocion ya no se encuentra vigente.', 409);
    }

    if (!hasOfferCapacity(offer)) {
      throw new AppError('La promocion ya no tiene cupos disponibles. Si desea, podemos continuar con el precio normal.', 409);
    }

    return {
      offer,
      snapshot: buildOfferSnapshot(offer, service)
    };
  }

  async function markRecipientSent(recipientId, conversationId = null) {
    if (!recipientId) {
      return null;
    }

    return prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        conversationId: conversationId || undefined
      }
    });
  }

  async function markRecipientFailed(recipientId, failedReason) {
    if (!recipientId) {
      return null;
    }

    return prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'FAILED',
        failedReason: failedReason || 'No se pudo enviar la campana.'
      }
    });
  }

  async function markRecipientResponded(recipientId) {
    if (!recipientId) {
      return null;
    }

    const recipient = await prisma.campaignRecipient.findUnique({
      where: { id: recipientId }
    });

    if (!recipient || ['BOOKED', 'OPTED_OUT'].includes(recipient.status)) {
      return recipient;
    }

    return prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'RESPONDED',
        respondedAt: new Date()
      }
    });
  }

  async function markRecipientBooked(recipientId, bookingId) {
    if (!recipientId) {
      return null;
    }

    return prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'BOOKED',
        bookingId,
        bookedAt: new Date()
      }
    });
  }

  async function markRecipientOptedOut(recipientId) {
    if (!recipientId) {
      return null;
    }

    const recipient = await prisma.campaignRecipient.findUnique({
      where: { id: recipientId }
    });

    if (!recipient || recipient.status === 'BOOKED') {
      return recipient;
    }

    return prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'OPTED_OUT',
        respondedAt: new Date()
      }
    });
  }

  async function incrementOfferRedemption(offerId) {
    if (!offerId) {
      return null;
    }

    return prisma.offer.update({
      where: { id: offerId },
      data: {
        usedRedemptions: {
          increment: 1
        }
      }
    });
  }

  return {
    getOfferById,
    getCampaignById,
    isOfferActive,
    hasOfferCapacity,
    buildOfferSnapshot,
    resolveBookingOffer,
    markRecipientSent,
    markRecipientFailed,
    markRecipientResponded,
    markRecipientBooked,
    markRecipientOptedOut,
    incrementOfferRedemption
  };
}

module.exports = { createCampaignService };
