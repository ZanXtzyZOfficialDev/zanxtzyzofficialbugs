// phone-helper.js - Phone Number Utilities for WhatsApp Connection

/**
 © Copyright By AiiSigma 
 */
function cleanPhoneNumber(number) {
    if (!number) return '';
    
    const cleaned = number.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
        return cleaned.substring(1);
    }
    
    return cleaned;
}

function isValidPhoneNumber(number) {
    const cleaned = cleanPhoneNumber(number);
    
    if (cleaned.length < 8 || cleaned.length > 15) {
        return false;
    }
    
    if (cleaned.startsWith('0')) {
        return false;
    }
    
    return /^\d+$/.test(cleaned);
}

function getCountryFromNumber(number) {
    const cleaned = cleanPhoneNumber(number);
    
    const countryCodes = {
        '1': { name: 'US/Canada', flag: '🇺🇸' },
        '44': { name: 'UK', flag: '🇬🇧' },
        '62': { name: 'Indonesia', flag: '🇮🇩' },
        '91': { name: 'India', flag: '🇮🇳' },
        '86': { name: 'China', flag: '🇨🇳' },
        '81': { name: 'Japan', flag: '🇯🇵' },
        '82': { name: 'South Korea', flag: '🇰🇷' },
        '55': { name: 'Brazil', flag: '🇧🇷' },
        '33': { name: 'France', flag: '🇫🇷' },
        '49': { name: 'Germany', flag: '🇩🇪' },
        '7': { name: 'Russia', flag: '🇷🇺' },
        '61': { name: 'Australia', flag: '🇦🇺' },
        '64': { name: 'New Zealand', flag: '🇳🇿' },
        '971': { name: 'UAE', flag: '🇦🇪' },
        '966': { name: 'Saudi Arabia', flag: '🇸🇦' },
        '20': { name: 'Egypt', flag: '🇪🇬' },
        '27': { name: 'South Africa', flag: '🇿🇦' },
        '34': { name: 'Spain', flag: '🇪🇸' },
        '39': { name: 'Italy', flag: '🇮🇹' },
        '46': { name: 'Sweden', flag: '🇸🇪' },
        '31': { name: 'Netherlands', flag: '🇳🇱' },
        '41': { name: 'Switzerland', flag: '🇨🇭' },
        '65': { name: 'Singapore', flag: '🇸🇬' },
        '60': { name: 'Malaysia', flag: '🇲🇾' },
        '63': { name: 'Philippines', flag: '🇵🇭' },
        '66': { name: 'Thailand', flag: '🇹🇭' },
        '84': { name: 'Vietnam', flag: '🇻🇳' },
        '90': { name: 'Turkey', flag: '🇹🇷' },
        '92': { name: 'Pakistan', flag: '🇵🇰' },
        '93': { name: 'Afghanistan', flag: '🇦🇫' },
        '94': { name: 'Sri Lanka', flag: '🇱🇰' },
        '95': { name: 'Myanmar', flag: '🇲🇲' },
        '98': { name: 'Iran', flag: '🇮🇷' },
        '212': { name: 'Morocco', flag: '🇲🇦' },
        '213': { name: 'Algeria', flag: '🇩🇿' },
        '216': { name: 'Tunisia', flag: '🇹🇳' },
        '218': { name: 'Libya', flag: '🇱🇾' },
        '220': { name: 'Gambia', flag: '🇬🇲' },
        '221': { name: 'Senegal', flag: '🇸🇳' },
        '222': { name: 'Mauritania', flag: '🇲🇷' },
        '223': { name: 'Mali', flag: '🇲🇱' },
        '224': { name: 'Guinea', flag: '🇬🇳' },
        '225': { name: 'Ivory Coast', flag: '🇨🇮' },
        '226': { name: 'Burkina Faso', flag: '🇧🇫' },
        '227': { name: 'Niger', flag: '🇳🇪' },
        '228': { name: 'Togo', flag: '🇹🇬' },
        '229': { name: 'Benin', flag: '🇧🇯' },
        '230': { name: 'Mauritius', flag: '🇲🇺' },
        '231': { name: 'Liberia', flag: '🇱🇷' },
        '232': { name: 'Sierra Leone', flag: '🇸🇱' },
        '233': { name: 'Ghana', flag: '🇬🇭' },
        '234': { name: 'Nigeria', flag: '🇳🇬' },
        '235': { name: 'Chad', flag: '🇹🇩' },
        '236': { name: 'Central African Republic', flag: '🇨🇫' },
        '237': { name: 'Cameroon', flag: '🇨🇲' },
        '238': { name: 'Cape Verde', flag: '🇨🇻' },
        '239': { name: 'Sao Tome and Principe', flag: '🇸🇹' },
        '240': { name: 'Equatorial Guinea', flag: '🇬🇶' },
        '241': { name: 'Gabon', flag: '🇬🇦' },
        '242': { name: 'Congo', flag: '🇨🇬' },
        '243': { name: 'DR Congo', flag: '🇨🇩' },
        '244': { name: 'Angola', flag: '🇦🇴' },
        '245': { name: 'Guinea-Bissau', flag: '🇬🇼' },
        '246': { name: 'Diego Garcia', flag: '🇮🇴' },
        '247': { name: 'Ascension Island', flag: '🇦🇨' },
        '248': { name: 'Seychelles', flag: '🇸🇨' },
        '249': { name: 'Sudan', flag: '🇸🇩' },
        '250': { name: 'Rwanda', flag: '🇷🇼' },
        '251': { name: 'Ethiopia', flag: '🇪🇹' },
        '252': { name: 'Somalia', flag: '🇸🇴' },
        '253': { name: 'Djibouti', flag: '🇩🇯' },
        '254': { name: 'Kenya', flag: '🇰🇪' },
        '255': { name: 'Tanzania', flag: '🇹🇿' },
        '256': { name: 'Uganda', flag: '🇺🇬' },
        '257': { name: 'Burundi', flag: '🇧🇮' },
        '258': { name: 'Mozambique', flag: '🇲🇿' },
        '260': { name: 'Zambia', flag: '🇿🇲' },
        '261': { name: 'Madagascar', flag: '🇲🇬' },
        '262': { name: 'Reunion', flag: '🇷🇪' },
        '263': { name: 'Zimbabwe', flag: '🇿🇼' },
        '264': { name: 'Namibia', flag: '🇳🇦' },
        '265': { name: 'Malawi', flag: '🇲🇼' },
        '266': { name: 'Lesotho', flag: '🇱🇸' },
        '267': { name: 'Botswana', flag: '🇧🇼' },
        '268': { name: 'Swaziland', flag: '🇸🇿' },
        '269': { name: 'Comoros', flag: '🇰🇲' },
        '290': { name: 'Saint Helena', flag: '🇸🇭' },
        '291': { name: 'Eritrea', flag: '🇪🇷' },
        '297': { name: 'Aruba', flag: '🇦🇼' },
        '298': { name: 'Faroe Islands', flag: '🇫🇴' },
        '299': { name: 'Greenland', flag: '🇬🇱' }
    };
    
    for (let i = 4; i >= 1; i--) {
        const code = cleaned.substring(0, i);
        if (countryCodes[code]) {
            return {
                code: code,
                name: countryCodes[code].name,
                flag: countryCodes[code].flag,
                rest: cleaned.substring(i)
            };
        }
    }
    
    return {
        code: 'Unknown',
        name: 'International',
        flag: '🌍',
        rest: cleaned
    };
}

function formatPhoneNumberWithFlag(number) {
    const countryInfo = getCountryFromNumber(number);
    return `${countryInfo.flag} +${countryInfo.code} ${countryInfo.rest}`;
}

function validateWhatsAppNumber(number) {
    const cleaned = cleanPhoneNumber(number);
    
    if (!isValidPhoneNumber(cleaned)) {
        return {
            valid: false,
            error: 'Invalid phone number format. Minimum 8 digits, maximum 15 digits required.',
            cleaned: cleaned
        };
    }
    
    const countryInfo = getCountryFromNumber(cleaned);
    
    return {
        valid: true,
        cleaned: cleaned,
        country: countryInfo.name,
        countryCode: countryInfo.code,
        flag: countryInfo.flag,
        formatted: formatPhoneNumberWithFlag(cleaned)
    };
}

module.exports = {
    cleanPhoneNumber,
    isValidPhoneNumber,
    getCountryFromNumber,
    formatPhoneNumberWithFlag,
    validateWhatsAppNumber
};